import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

final class RecordingExchange: HTTPExchange, @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [HTTPExchangeResponse]
    private var streams: [(status: Int, lines: [String])]
    private(set) var requests: [URLRequest] = []

    init(_ responses: [HTTPExchangeResponse], streams: [(status: Int, lines: [String])] = []) {
        self.responses = responses
        self.streams = streams
    }

    func send(_ request: URLRequest) async throws -> HTTPExchangeResponse {
        lock.withLock {
            requests.append(request)
            return responses.removeFirst()
        }
    }

    func stream(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<String, Error>) {
        let next = lock.withLock { () -> (status: Int, lines: [String])? in
            requests.append(request)
            return streams.isEmpty ? nil : streams.removeFirst()
        }
        guard let next else { throw HTTPExchangeError.streamingUnsupported }
        let chunks = AsyncThrowingStream<String, Error> { continuation in
            for line in next.lines { continuation.yield(line) }
            continuation.finish()
        }
        return (next.status, chunks)
    }
}

@Suite struct DeviceHTTPClientTests {
    @Test func streamRefusedAsRevokedEndsTheEventStreamWithSessionInvalid() async throws {
        let exchange = RecordingExchange([], streams: [(403, [#"{"error":{"code":"DEVICE_REVOKED"}}"#])])
        let (http, _) = try client(exchange)
        var events: [DeviceStreamEvent] = []
        let stream = DeviceEventStream(http: http, cursors: nil, heartbeat: { 30 })
        for await event in stream.start() { events.append(event) }
        #expect(events == [.sessionInvalid])
        #expect(exchange.requests.count == 1)
    }

    @Test func streamCorrectsTheClockOnceWhenTheServerSaysSkewed() async throws {
        let skewed = #"{"error":{"code":"DEVICE_SIGNATURE_CLOCK_SKEW","serverTime":"2027-01-15T08:10:00Z"}}"#
        let exchange = RecordingExchange([], streams: [(401, [skewed]), (200, [])])
        let (http, _) = try client(exchange)
        _ = try await http.openStream(DeviceRequest(method: "GET", path: "stream"))
        #expect(exchange.requests.count == 2)
        let first = try #require(exchange.requests[0].value(forHTTPHeaderField: "Signature-Input"))
        let second = try #require(exchange.requests[1].value(forHTTPHeaderField: "Signature-Input"))
        #expect(first.contains("created=1800000000"))
        #expect(second.contains("created=1800000600"))
    }

    @Test func streamRefusalKeepsTheServerCode() async throws {
        let exchange = RecordingExchange([], streams: [(429, [#"{"error":{"code":"DEVICE_NONCE_STORE_FULL"}}"#])])
        let (http, _) = try client(exchange)
        await #expect(throws: DeviceAPIError.server(status: 429, code: "DEVICE_NONCE_STORE_FULL")) {
            _ = try await http.openStream(DeviceRequest(method: "GET", path: "stream"))
        }
    }

    private func client(_ exchange: RecordingExchange, access: ServiceAccessToken? = nil, at time: TimeInterval = 1_800_000_000) throws -> (DeviceHTTPClient, SoftwareKeySigner) {
        let signer = try SoftwareKeySigner()
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: time) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test:8443/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: access, deviceKey: signer))
        return (http, signer)
    }

    private func components(_ request: URLRequest) throws -> DeviceRequestTarget {
        let url = try #require(request.url)
        let parts = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        return DeviceRequestTarget(
            method: try #require(request.httpMethod),
            authority: "\(url.host ?? ""):\(url.port ?? 0)",
            path: parts.percentEncodedPath,
            rawQuery: parts.percentEncodedQuery ?? "",
            body: request.httpBody,
            contentType: request.value(forHTTPHeaderField: "Content-Type")
        )
    }

    private func verify(_ request: URLRequest, signer: SoftwareKeySigner) throws -> Bool {
        let input = try #require(request.value(forHTTPHeaderField: "Signature-Input"))
        let createdRange = try #require(input.range(of: "created=[0-9]+", options: .regularExpression))
        let created = input[createdRange].dropFirst(8)
        let nonceRange = try #require(input.range(of: "nonce=\"[^\"]+\"", options: .regularExpression))
        let nonce = input[nonceRange].dropFirst(7).dropLast()
        let createdSeconds = try #require(Int64(String(created)))
        let parameters = DeviceSignatureParameters(deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", created: createdSeconds, nonce: String(nonce))
        let base = DeviceSignature.signatureBase(target: try components(request), parameters: parameters)
        let header = try #require(request.value(forHTTPHeaderField: "Signature"))
        let signature = try #require(Data(base64Encoded: String(header.dropFirst("device=:".count).dropLast())))
        return SoftwareKeySigner.verify(signature: signature, message: Data(base.utf8), publicKeySPKI: try signer.publicKeySPKI())
    }

    @Test func signsQueryAndBodyAndAddsAccessHeaders() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data("{}".utf8))])
        let (http, signer) = try client(exchange, access: ServiceAccessToken(clientId: "cid", secret: "csecret"))
        _ = try await http.send(DeviceRequest(method: "POST", path: "messages", query: [URLQueryItem(name: "a", value: "x y/z")], body: Data("{\"t\":\"大阪\"}".utf8)))
        let request = try #require(exchange.requests.first)
        #expect(request.url?.absoluteString == "https://himawari.example.test:8443/api/device/v1/messages?a=x%20y%2Fz")
        #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == "cid")
        #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == "csecret")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Content-Digest") == DeviceSignature.contentDigest(Data("{\"t\":\"大阪\"}".utf8)))
        #expect(try verify(request, signer: signer))
    }

    @Test func eachRequestUsesAFreshNonce() async throws {
        let ok = HTTPExchangeResponse(status: 200, body: Data("{}".utf8))
        let exchange = RecordingExchange([ok, ok])
        let (http, _) = try client(exchange)
        _ = try await http.send(DeviceRequest(method: "GET", path: "config"))
        _ = try await http.send(DeviceRequest(method: "GET", path: "config"))
        let inputs = exchange.requests.compactMap { $0.value(forHTTPHeaderField: "Signature-Input") }
        #expect(inputs.count == 2)
        #expect(inputs[0] != inputs[1])
    }

    @Test func clockSkewIsCorrectedOnceFromServerTime() async throws {
        let skew = HTTPExchangeResponse(status: 401, body: Data("{\"error\":{\"code\":\"DEVICE_SIGNATURE_CLOCK_SKEW\",\"serverTime\":\"2027-01-15T08:00:00.000Z\"}}".utf8))
        let exchange = RecordingExchange([skew, HTTPExchangeResponse(status: 200, body: Data("{}".utf8))])
        let (http, _) = try client(exchange)
        _ = try await http.send(DeviceRequest(method: "GET", path: "config"))
        #expect(exchange.requests.count == 2)
        let second = try #require(exchange.requests.last?.value(forHTTPHeaderField: "Signature-Input"))
        let expected = Int64(ISO8601DateFormatter().date(from: "2027-01-15T08:00:00Z")!.timeIntervalSince1970)
        #expect(second.contains("created=\(expected);"))
    }

    @Test func repeatedSkewIsNotRetriedForever() async throws {
        let skew = HTTPExchangeResponse(status: 401, body: Data("{\"error\":{\"code\":\"DEVICE_SIGNATURE_CLOCK_SKEW\",\"serverTime\":\"2027-01-15T08:00:00.000Z\"}}".utf8))
        let exchange = RecordingExchange([skew, skew])
        let (http, _) = try client(exchange)
        await #expect(throws: DeviceAPIError.server(status: 401, code: "DEVICE_SIGNATURE_CLOCK_SKEW")) {
            _ = try await http.send(DeviceRequest(method: "GET", path: "config"))
        }
        #expect(exchange.requests.count == 2)
    }

    @Test func serverErrorCodesAreSurfaced() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 403, body: Data("{\"error\":{\"code\":\"DEVICE_REVOKED\"}}".utf8))])
        let (http, _) = try client(exchange)
        do {
            _ = try await http.send(DeviceRequest(method: "GET", path: "config"))
            Issue.record("expected error")
        } catch let error as DeviceAPIError {
            #expect(error.isRevoked)
        }
    }

    @Test func serverReasonCodeIsKeptWithTheErrorCode() async throws {
        let body = "{\"error\":{\"code\":\"PORT_CONFLICT\",\"reasonCode\":\"LOGIN_DEVICES_STILL_CHANGING\"}}"
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 409, body: Data(body.utf8))])
        let (http, _) = try client(exchange)
        await #expect(throws: DeviceAPIError.server(status: 409, code: "PORT_CONFLICT", reason: "LOGIN_DEVICES_STILL_CHANGING")) {
            _ = try await http.send(DeviceRequest(method: "POST", path: "gateway"))
        }
    }

    @Test func unpairedClientRefusesToSend() async throws {
        let http = DeviceHTTPClient(exchange: RecordingExchange([]))
        await #expect(throws: DeviceAPIError.server(status: 401, code: "DEVICE_NOT_PAIRED")) {
            _ = try await http.send(DeviceRequest(method: "GET", path: "config"))
        }
    }

    @Test func pairPostsWithoutSignature() async throws {
        let body = """
        {"device":{"id":"dev_AAAAAAAAAAAAAAAAAAAAAA","revision":1,"kind":"iphone","name":"Andy 的 iPhone","releaseChannel":"direct","status":"pending","pairedAt":"x","confirmedAt":null,"revokedAt":null,"lastSeenAt":null}}
        """
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 201, body: Data(body.utf8))])
        let api = DeviceAPI(http: DeviceHTTPClient(exchange: exchange))
        let invitation = PairingInvitation(origin: try #require(URL(string: "https://himawari.example.test")), code: "abcdefghijklmnopqrstuv", access: nil)
        let device = try await api.pair(invitation: invitation, kind: .iphone, name: "Andy 的 iPhone", releaseChannel: .direct, deviceKey: try SoftwareKeySigner(), confirmKey: try SoftwareKeySigner())
        #expect(device.status == .pending)
        let request = try #require(exchange.requests.first)
        #expect(request.value(forHTTPHeaderField: "Signature") == nil)
        let httpBody = try #require(request.httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: httpBody) as? [String: String])
        #expect(Set(sent.keys) == ["pairingCode", "kind", "name", "releaseChannel", "devicePublicKey", "confirmPublicKey"])
        #expect(sent["devicePublicKey"] != sent["confirmPublicKey"])
    }

    @Test func commandOutcomesDecodeResultAndConflict() throws {
        let api = DeviceAPI(http: DeviceHTTPClient(exchange: RecordingExchange([])))
        let result = Data("{\"type\":\"thread.command_result\",\"payload\":{\"threadRevision\":4,\"replayed\":true}}".utf8)
        #expect(try api.outcome(result) == .accepted(threadRevision: 4, replayed: true))
        let conflict = Data("{\"type\":\"thread.conflict\",\"payload\":{\"reasonCode\":\"STALE\",\"latest\":null}}".utf8)
        #expect(try api.outcome(conflict) == .conflict(reasonCode: "STALE", latest: nil))
        #expect(throws: DeviceAPIError.invalidResponse) { try api.outcome(Data("{\"type\":\"other\"}".utf8)) }
    }
}

@Suite struct ConfirmSignatureTests {
    @Test func confirmSignerAddsSecondLabelWithTheGivenNonce() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data("{}".utf8))])
        let device = try SoftwareKeySigner()
        let confirm = try SoftwareKeySigner()
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: device))
        _ = try await http.send(DeviceRequest(method: "POST", path: "gateway", body: Data("{}".utf8), nonce: "challenge_0123456789", confirmSigner: confirm))
        let request = try #require(exchange.requests.first)
        let input = try #require(request.value(forHTTPHeaderField: "Signature-Input"))
        let members = input.components(separatedBy: ", ")
        #expect(members.count == 2)
        #expect(members[0].hasPrefix("device=("))
        #expect(members[1].hasPrefix("confirm=("))
        #expect(members.allSatisfy { $0.contains("nonce=\"challenge_0123456789\"") })
        let signatures = try #require(request.value(forHTTPHeaderField: "Signature")).components(separatedBy: ", ")
        #expect(signatures.count == 2)
        #expect(signatures[1].hasPrefix("confirm=:"))
    }

    @Test func withoutConfirmSignerOnlyDeviceLabelIsSent() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data("{}".utf8))])
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        _ = try await http.send(DeviceRequest(method: "GET", path: "config"))
        let input = try #require(exchange.requests.first?.value(forHTTPHeaderField: "Signature-Input"))
        #expect(!input.contains("confirm="))
    }
}
