import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

private final class ScriptedCeremony: PasskeyCeremony, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var registered: [PasskeyRegistrationOptions] = []
    private(set) var asserted: [(PasskeyAssertionOptions, Bool)] = []
    let registerError: PasskeyCeremonyError?
    let assertError: PasskeyCeremonyError?

    init(registerError: PasskeyCeremonyError? = nil, assertError: PasskeyCeremonyError? = nil) {
        self.registerError = registerError
        self.assertError = assertError
    }

    func register(_ options: PasskeyRegistrationOptions) async throws -> PasskeyRegistration {
        lock.withLock { registered.append(options) }
        if let registerError { throw registerError }
        return PasskeyRegistration(credentialId: Data([1, 2, 3]), clientDataJSON: Data("{}".utf8), attestationObject: Data([9, 9]))
    }

    func assert(_ options: PasskeyAssertionOptions, immediatelyAvailableOnly: Bool) async throws -> PasskeyAssertion {
        lock.withLock { asserted.append((options, immediatelyAvailableOnly)) }
        if let assertError { throw assertError }
        return PasskeyAssertion(credentialId: Data([1, 2, 3]), clientDataJSON: Data("{}".utf8), authenticatorData: Data([7]), signature: Data([8]), userHandle: Data([5]))
    }
}

@Suite struct SignInTests {
    private static let origin = URL(string: "https://himawari.example.test")!
    private static let rule = SetupCodeRule(length: 8, groupSize: 4, alphabet: "ABCDEFGHJKMNPQRSTUVWXYZ23456789")
    private static let info = SignInInfo(rpId: "himawari.example.test", setupCode: rule)
    private static let deviceJSON = #"{"device":{"id":"dev_new","revision":1,"kind":"iphone","name":"iPhone","releaseChannel":"testflight","status":"active","pairedAt":"2026-11-26T00:00:00.000Z","lastSeenAt":null}}"#
    private static let creation = #"{"flowId":"flow-1","publicKey":{"challenge":"AQID","rp":{"id":"himawari.example.test","name":"Himawari"},"user":{"id":"BAUG","name":"Himawari · himawari.example.test","displayName":"Andy"},"pubKeyCredParams":[{"type":"public-key","alg":-7}],"excludeCredentials":[{"type":"public-key","id":"CQ"}]}}"#
    private static let request = #"{"flowId":"flow-2","publicKey":{"challenge":"AQID","rpId":"himawari.example.test","allowCredentials":[],"userVerification":"required"}}"#

    private static func device() throws -> SignInDevice {
        SignInDevice(kind: .iphone, name: "iPhone", releaseChannel: .testflight, devicePublicKey: try SoftwareKeySigner().publicKeySPKI(), confirmPublicKey: try SoftwareKeySigner().publicKeySPKI())
    }

    private static func json(_ request: URLRequest) throws -> [String: Any] {
        let body = try #require(request.httpBody)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test func setupCodeIsCleanedGroupedAndCheckedByTheServerRule() {
        #expect(Self.rule.display(" k7qm 4x-hp ") == "K7QM-4XHP")
        #expect(Self.rule.isComplete("k7qm-4xhp"))
        #expect(!Self.rule.isComplete("K7QM-4XH"))
        #expect(!Self.rule.isComplete("K7QM-4XH0"))
        #expect(Self.rule.display("K7QM4XHPZZZ") == "K7QM-4XHP")
        #expect(SetupCodeEntry.ready("x", rule: nil))
        #expect(!SetupCodeEntry.ready("  - ", rule: nil))
    }

    @Test func publicSignInInfoIsReadWithoutASignature() async throws {
        let body = #"{"rpId":"himawari.example.test","setupCode":{"length":8,"groupSize":4,"alphabet":"ABC"}}"#
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(body.utf8))])
        let info = try await DeviceAPI(http: DeviceHTTPClient(exchange: exchange)).signInInfo(origin: Self.origin)
        #expect(info.setupCode.length == 8)
        let request = try #require(exchange.requests.first)
        #expect(request.url?.absoluteString == "https://himawari.example.test/api/device/v1/sign-in")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Signature") == nil)
    }

    @Test func firstSetupSendsCodeAndKeysThenTheNewPasskey() async throws {
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 200, body: Data(Self.creation.utf8)),
            HTTPExchangeResponse(status: 201, body: Data(Self.deviceJSON.utf8)),
        ])
        let ceremony = ScriptedCeremony()
        let flow = SignInFlow(api: DeviceAPI(http: DeviceHTTPClient(exchange: exchange)), ceremony: ceremony)
        let device = try await flow.setUp(origin: Self.origin, setupCode: "k7qm4xhp", device: try Self.device(), info: Self.info)
        #expect(device.id == "dev_new")
        #expect(device.status == .active)
        let options = try #require(ceremony.registered.first)
        #expect(options.relyingParty == "himawari.example.test")
        #expect(options.challenge == Data([1, 2, 3]))
        #expect(options.userId == Data([4, 5, 6]))
        #expect(options.userName == "Himawari · himawari.example.test")
        #expect(options.excluded == [Data([9])])
        let first = try Self.json(exchange.requests[0])
        #expect(exchange.requests[0].url?.path == "/api/device/v1/sign-in/setup/options")
        #expect(first["setupCode"] as? String == "K7QM-4XHP")
        let sentDevice = try #require(first["device"] as? [String: String])
        #expect(Set(sentDevice.keys) == ["kind", "name", "releaseChannel", "devicePublicKey", "confirmPublicKey"])
        let second = try Self.json(exchange.requests[1])
        #expect(exchange.requests[1].url?.path == "/api/device/v1/sign-in/setup/finish")
        #expect(second["flowId"] as? String == "flow-1")
        let credential = try #require(second["credential"] as? [String: Any])
        #expect(credential["id"] as? String == "AQID")
        #expect(credential["rawId"] as? String == "AQID")
        #expect(credential["type"] as? String == "public-key")
        let response = try #require(credential["response"] as? [String: Any])
        #expect(response["attestationObject"] as? String == "CQk")
        #expect(response["clientDataJSON"] as? String == "e30")
    }

    @Test func cancelingTheSystemPanelAfterTheCodeKeepsTheCodeUsable() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(Self.creation.utf8))])
        let flow = SignInFlow(api: DeviceAPI(http: DeviceHTTPClient(exchange: exchange)), ceremony: ScriptedCeremony(registerError: .canceled))
        await #expect(throws: SignInFlowError.passkeyNotCreated) {
            _ = try await flow.setUp(origin: Self.origin, setupCode: "K7QM4XHP", device: try Self.device(), info: Self.info)
        }
        #expect(exchange.requests.count == 1)
        #expect(SignInProblem.from(SignInFlowError.passkeyNotCreated) == .passkeyNeededAfterCode)
    }

    @Test func passkeySignInAsksTheSystemQuietlyWhenTold() async throws {
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 200, body: Data(Self.request.utf8)),
            HTTPExchangeResponse(status: 200, body: Data(Self.deviceJSON.utf8)),
        ])
        let ceremony = ScriptedCeremony()
        let flow = SignInFlow(api: DeviceAPI(http: DeviceHTTPClient(exchange: exchange)), ceremony: ceremony)
        _ = try await flow.signIn(origin: Self.origin, device: try Self.device(), info: nil, immediatelyAvailableOnly: true)
        let (options, quiet) = try #require(ceremony.asserted.first)
        #expect(quiet)
        #expect(options.relyingParty == "himawari.example.test")
        #expect(options.allowed.isEmpty)
        #expect(exchange.requests[0].url?.path == "/api/device/v1/sign-in/options")
        let finish = try Self.json(exchange.requests[1])
        let credential = try #require(finish["credential"] as? [String: Any])
        let response = try #require(credential["response"] as? [String: Any])
        #expect(response["authenticatorData"] as? String == "Bw")
        #expect(response["signature"] as? String == "CA")
        #expect(response["userHandle"] as? String == "BQ")
    }

    @Test func noPasskeyOnThisDeviceStopsBeforeFinishing() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(Self.request.utf8))])
        let flow = SignInFlow(api: DeviceAPI(http: DeviceHTTPClient(exchange: exchange)), ceremony: ScriptedCeremony(assertError: .noCredential))
        do {
            _ = try await flow.signIn(origin: Self.origin, device: try Self.device(), info: nil, immediatelyAvailableOnly: true)
            Issue.record("expected no passkey")
        } catch {
            #expect(SignInProblem.from(error) == .noPasskeyHere)
        }
        #expect(exchange.requests.count == 1)
    }

    @Test func serverAnswersBecomeTheFourThingsThePhoneShows() async throws {
        func problem(_ status: Int, _ code: String, headers: [String: String] = [:]) async -> SignInProblem? {
            let exchange = RecordingExchange([HTTPExchangeResponse(status: status, body: Data(#"{"error":{"code":"\#(code)"}}"#.utf8), headers: headers)])
            let api = DeviceAPI(http: DeviceHTTPClient(exchange: exchange))
            do {
                _ = try await api.setUpOptions(origin: Self.origin, setupCode: "K7QM-4XHP", device: try Self.device(), relyingParty: "x")
                return nil
            } catch {
                return SignInProblem.from(error)
            }
        }
        #expect(await problem(401, "DEVICE_SETUP_CODE_INVALID") == .codeInvalid)
        #expect(await problem(410, "DEVICE_SETUP_CODE_EXPIRED") == .codeExpired)
        #expect(await problem(429, "DEVICE_SETUP_CODE_ATTEMPTS", headers: ["Retry-After": "300"]) == .tooManyAttempts(retryAfterMinutes: 5))
        #expect(await problem(429, "DEVICE_SETUP_CODE_ATTEMPTS", headers: ["retry-after": "61"]) == .tooManyAttempts(retryAfterMinutes: 2))
        #expect(await problem(429, "DEVICE_SETUP_CODE_ATTEMPTS") == .tooManyAttempts(retryAfterMinutes: nil))
        #expect(await problem(401, "DEVICE_PASSKEY_REJECTED") == .passkeyRejected)
        #expect(await problem(410, "DEVICE_SIGN_IN_FLOW_EXPIRED") == .tryAgain)
        #expect(await problem(418, "SOMETHING_NEW") == .unreachable(code: "SOMETHING_NEW"))
        #expect(SignInProblem.from(URLError(.notConnectedToInternet)) == .unreachable(code: nil))
    }

    @Test func serverAddressMustBeAPlainHTTPSOrigin() {
        #expect(ServerOrigin.parse("himawari.example.test")?.absoluteString == "https://himawari.example.test")
        #expect(ServerOrigin.parse("https://himawari.example.test/")?.absoluteString == "https://himawari.example.test")
        #expect(ServerOrigin.parse("http://himawari.example.test") == nil)
        #expect(ServerOrigin.parse("https://himawari.example.test/api") == nil)
        #expect(ServerOrigin.parse("https://user@himawari.example.test") == nil)
        #expect(ServerOrigin.parse("$(HIMAWARI_SERVER_ORIGIN)") == nil)
        #expect(ServerOrigin.parse("") == nil)
        #expect(ServerOrigin.host(URL(string: "https://h.example:8443")!) == "h.example:8443")
    }
}
