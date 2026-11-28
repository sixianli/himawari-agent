import Foundation

extension DeviceAPI {
    public static let signInPath = "sign-in"

    public func signInInfo(origin: URL) async throws -> SignInInfo {
        let response = try await http.unsigned(origin: origin, method: "GET", path: Self.signInPath)
        return try decode(SignInInfo.self, try Self.checkSignIn(response))
    }

    public func setUpOptions(origin: URL, setupCode: String, device: SignInDevice, relyingParty: String) async throws -> SignInStart<PasskeyRegistrationOptions> {
        struct Body: Encodable {
            let setupCode: String
            let device: SignInDevice
        }
        let data = try await unsignedPost(origin: origin, path: "sign-in/setup/options", body: Body(setupCode: setupCode, device: device))
        return try WebAuthnJSON.registration(data, fallbackRelyingParty: relyingParty)
    }

    public func setUpFinish(origin: URL, flowId: String, registration: PasskeyRegistration) async throws -> PairedDeviceInfo {
        try await finish(origin: origin, path: "sign-in/setup/finish", flowId: flowId, credential: WebAuthnJSON.registrationResponse(registration))
    }

    public func signInOptions(origin: URL, device: SignInDevice, relyingParty: String) async throws -> SignInStart<PasskeyAssertionOptions> {
        struct Body: Encodable { let device: SignInDevice }
        let data = try await unsignedPost(origin: origin, path: "sign-in/options", body: Body(device: device))
        return try WebAuthnJSON.assertion(data, fallbackRelyingParty: relyingParty)
    }

    public func signInFinish(origin: URL, flowId: String, assertion: PasskeyAssertion) async throws -> PairedDeviceInfo {
        try await finish(origin: origin, path: "sign-in/finish", flowId: flowId, credential: WebAuthnJSON.assertionResponse(assertion))
    }

    private func finish(origin: URL, path: String, flowId: String, credential: [String: SignInJSON]) async throws -> PairedDeviceInfo {
        let body: [String: SignInJSON] = ["flowId": .string(flowId), "credential": .object(credential)]
        let data = try await unsignedPost(origin: origin, path: path, body: body)
        struct Body: Decodable { let device: PairedDeviceInfo }
        return try decode(Body.self, data).device
    }

    private func unsignedPost<Body: Encodable>(origin: URL, path: String, body: Body) async throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let response = try await http.unsigned(origin: origin, method: "POST", path: path, body: try encoder.encode(body))
        return try Self.checkSignIn(response)
    }

    static func checkSignIn(_ response: HTTPExchangeResponse) throws -> Data {
        if response.status == 429 {
            throw SignInError.tooManyAttempts(retryAfterSeconds: response.header("Retry-After").flatMap { Int($0.trimmingCharacters(in: .whitespaces)) })
        }
        return try DeviceHTTPClient.check(response)
    }
}

public struct SignInFlow: Sendable {
    public let api: DeviceAPI
    public let ceremony: PasskeyCeremony

    public init(api: DeviceAPI, ceremony: PasskeyCeremony) {
        self.api = api
        self.ceremony = ceremony
    }

    public func setUp(origin: URL, setupCode: String, device: SignInDevice, info: SignInInfo?) async throws -> PairedDeviceInfo {
        let rule = info?.setupCode
        let relyingParty = info?.rpId ?? ServerOrigin.host(origin)
        let start = try await api.setUpOptions(origin: origin, setupCode: SetupCodeEntry.submitted(setupCode, rule: rule), device: device, relyingParty: relyingParty)
        let registration: PasskeyRegistration
        do {
            registration = try await ceremony.register(start.options)
        } catch PasskeyCeremonyError.canceled {
            throw SignInFlowError.passkeyNotCreated
        }
        return try await api.setUpFinish(origin: origin, flowId: start.flowId, registration: registration)
    }

    public func signIn(origin: URL, device: SignInDevice, info: SignInInfo?, immediatelyAvailableOnly: Bool) async throws -> PairedDeviceInfo {
        let relyingParty = info?.rpId ?? ServerOrigin.host(origin)
        let start = try await api.signInOptions(origin: origin, device: device, relyingParty: relyingParty)
        let assertion = try await ceremony.assert(start.options, immediatelyAvailableOnly: immediatelyAvailableOnly)
        return try await api.signInFinish(origin: origin, flowId: start.flowId, assertion: assertion)
    }
}

public enum SignInFlowError: Error, Equatable, Sendable {
    case passkeyNotCreated
}
