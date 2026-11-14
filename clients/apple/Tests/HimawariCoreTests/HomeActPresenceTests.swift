import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

private struct RefusingSigner: DeviceKeySigner {
    struct Cancelled: Error {}
    let key: SoftwareKeySigner

    func publicKeySPKI() throws -> Data { try key.publicKeySPKI() }
    func sign(_ message: Data, reason: String?) async throws -> Data { throw Cancelled() }
}

@Suite struct HomeActPresenceTests {
    private static let deviceId = "dev_AAAAAAAAAAAAAAAAAAAAAA"
    private static let challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    private func item(ownerPresence: Bool) -> (HomeItem, HomeAction) {
        let action = HomeAction(action: "approved", label: "同意", polarity: "positive", ownerPresence: ownerPresence, binding: "b1.binding")
        let item = HomeItem(key: "approval:a1", kind: "approval", awaitsOwner: true, sentence: "要不要同意", actions: [action])
        return (item, action)
    }

    private func api(_ exchange: RecordingExchange) throws -> (DeviceAPI, SoftwareKeySigner) {
        let device = try SoftwareKeySigner()
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: Self.deviceId, access: nil, deviceKey: device))
        return (DeviceAPI(http: http), device)
    }

    private func signatureBase(_ request: URLRequest, nonce: String) throws -> Data {
        let url = try #require(request.url)
        let parts = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let target = DeviceRequestTarget(
            method: try #require(request.httpMethod),
            authority: url.host ?? "",
            path: parts.percentEncodedPath,
            rawQuery: parts.percentEncodedQuery ?? "",
            body: request.httpBody,
            contentType: request.value(forHTTPHeaderField: "Content-Type")
        )
        let input = try #require(request.value(forHTTPHeaderField: "Signature-Input"))
        let createdRange = try #require(input.range(of: "created=[0-9]+", options: .regularExpression))
        let created = try #require(Int64(String(input[createdRange].dropFirst(8))))
        let parameters = DeviceSignatureParameters(deviceId: Self.deviceId, created: created, nonce: nonce)
        return Data(DeviceSignature.signatureBase(target: target, parameters: parameters).utf8)
    }

    private func signatures(_ request: URLRequest) throws -> [String: Data] {
        let header = try #require(request.value(forHTTPHeaderField: "Signature"))
        var result: [String: Data] = [:]
        for member in header.components(separatedBy: ", ") {
            let parts = member.split(separator: "=", maxSplits: 1).map(String.init)
            let value = parts[1].dropFirst().dropLast()
            result[parts[0]] = try #require(Data(base64Encoded: String(value)))
        }
        return result
    }

    @Test func ownerPresenceActionFetchesAChallengeAndSignsWithTheConfirmKey() async throws {
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 201, body: Data(#"{"challenge":"\#(Self.challenge)","expiresAt":"2027-01-15T08:05:00.000Z"}"#.utf8)),
            HTTPExchangeResponse(status: 200, body: Data("{}".utf8)),
        ])
        let (api, device) = try api(exchange)
        let confirm = try SoftwareKeySigner()
        let (item, action) = item(ownerPresence: true)
        try await api.act(on: item, action: action, requestId: "req-1", presence: OwnerPresenceSigner(key: confirm, reason: "确认"))

        #expect(exchange.requests.count == 2)
        #expect(exchange.requests[0].url?.path == "/api/device/v1/approvals/challenge")
        #expect(exchange.requests[0].value(forHTTPHeaderField: "Signature-Input")?.contains("confirm=") == false)
        let act = exchange.requests[1]
        #expect(act.url?.path == "/api/device/v1/home/act")
        let input = try #require(act.value(forHTTPHeaderField: "Signature-Input"))
        #expect(input.components(separatedBy: ", ").allSatisfy { $0.contains("nonce=\"\(Self.challenge)\"") })
        let base = try signatureBase(act, nonce: Self.challenge)
        let signed = try signatures(act)
        #expect(SoftwareKeySigner.verify(signature: try #require(signed["device"]), message: base, publicKeySPKI: try device.publicKeySPKI()))
        #expect(SoftwareKeySigner.verify(signature: try #require(signed["confirm"]), message: base, publicKeySPKI: try confirm.publicKeySPKI()))
    }

    @Test func actionWithoutOwnerPresenceIsSentDirectlyWithoutChallengeOrConfirmSignature() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data("{}".utf8))])
        let (api, _) = try api(exchange)
        let (item, action) = item(ownerPresence: false)
        try await api.act(on: item, action: action, requestId: "req-2", presence: OwnerPresenceSigner(key: try SoftwareKeySigner(), reason: "确认"))

        #expect(exchange.requests.map { $0.url?.path } == ["/api/device/v1/home/act"])
        #expect(exchange.requests[0].value(forHTTPHeaderField: "Signature-Input")?.contains("confirm=") == false)
    }

    @Test func cancelledConfirmationSendsNothingToHomeAct() async throws {
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 201, body: Data(#"{"challenge":"\#(Self.challenge)","expiresAt":"2027-01-15T08:05:00.000Z"}"#.utf8)),
        ])
        let (api, _) = try api(exchange)
        let (item, action) = item(ownerPresence: true)
        let presence = OwnerPresenceSigner(key: RefusingSigner(key: try SoftwareKeySigner()), reason: "确认")
        await #expect(throws: OwnerPresenceError.declined) {
            try await api.act(on: item, action: action, requestId: "req-3", presence: presence)
        }
        #expect(exchange.requests.map { $0.url?.path } == ["/api/device/v1/approvals/challenge"])
    }

    @Test func ownerPresenceActionWithoutASignerIsRefusedBeforeAnyRequest() async throws {
        let exchange = RecordingExchange([])
        let (api, _) = try api(exchange)
        let (item, action) = item(ownerPresence: true)
        await #expect(throws: OwnerPresenceError.unavailable) {
            try await api.act(on: item, action: action, requestId: "req-4")
        }
        #expect(exchange.requests.isEmpty)
    }

    @Test func missingConfirmKeyIsReportedAsAKeyErrorNotAsADecline() async throws {
        struct MissingKey: DeviceKeySigner {
            func publicKeySPKI() throws -> Data { throw DeviceKeyError.keyMissing(.confirm) }
            func sign(_ message: Data, reason: String?) async throws -> Data { throw DeviceKeyError.keyMissing(.confirm) }
        }
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 201, body: Data(#"{"challenge":"\#(Self.challenge)","expiresAt":"2027-01-15T08:05:00.000Z"}"#.utf8)),
        ])
        let (api, _) = try api(exchange)
        let (item, action) = item(ownerPresence: true)
        await #expect(throws: DeviceKeyError.keyMissing(.confirm)) {
            try await api.act(on: item, action: action, requestId: "req-5", presence: OwnerPresenceSigner(key: MissingKey(), reason: "确认"))
        }
    }
}
