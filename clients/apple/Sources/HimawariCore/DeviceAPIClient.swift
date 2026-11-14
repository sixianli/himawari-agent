import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct DeviceCredentials: Sendable {
    public let origin: URL
    public let deviceId: String
    public let access: ServiceAccessToken?
    public let deviceKey: DeviceKeySigner

    public init(origin: URL, deviceId: String, access: ServiceAccessToken?, deviceKey: DeviceKeySigner) {
        self.origin = origin
        self.deviceId = deviceId
        self.access = access
        self.deviceKey = deviceKey
    }
}

public enum DeviceAPIError: Error, Sendable, Equatable {
    case server(status: Int, code: String?, pairingCodeTtlSeconds: Int? = nil, reason: String? = nil)
    case invalidResponse

    public var code: String? {
        if case let .server(_, code, _, _) = self { return code }
        return nil
    }

    public var isRevoked: Bool { code == "DEVICE_REVOKED" }
    public var isPending: Bool { code == "DEVICE_PENDING" }
}

public struct DeviceRequest: Sendable {
    public let method: String
    public let path: String
    public let query: [URLQueryItem]
    public let body: Data?
    public let contentType: String?
    public let extraHeaders: [String: String]
    public let nonce: String?
    public let confirmSigner: DeviceKeySigner?
    public let confirmReason: String?

    public init(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        contentType: String? = nil,
        extraHeaders: [String: String] = [:],
        nonce: String? = nil,
        confirmSigner: DeviceKeySigner? = nil,
        confirmReason: String? = nil
    ) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.contentType = body == nil ? nil : (contentType ?? "application/json")
        self.extraHeaders = extraHeaders
        self.nonce = nonce
        self.confirmSigner = confirmSigner
        self.confirmReason = confirmReason
    }
}

public final class DeviceHTTPClient: @unchecked Sendable {
    public static let prefix = "/api/device/v1/"

    private let exchange: HTTPExchange
    private let lock = NSLock()
    private var credentials: DeviceCredentials?
    private var clockOffset: TimeInterval = 0
    private let now: @Sendable () -> Date

    public init(exchange: HTTPExchange = URLSessionExchange(), now: @escaping @Sendable () -> Date = Date.init) {
        self.exchange = exchange
        self.now = now
    }

    public func use(_ credentials: DeviceCredentials?) {
        lock.withLock {
            self.credentials = credentials
            clockOffset = 0
        }
    }

    public var currentCredentials: DeviceCredentials? {
        lock.withLock { credentials }
    }

    public func send(_ request: DeviceRequest) async throws -> Data {
        let response = try await perform(request, allowClockRetry: true)
        return response
    }

    public static let streamErrorBodyLimit = 16 * 1024

    public func openStream(_ request: DeviceRequest) async throws -> AsyncThrowingStream<String, Error> {
        try await openStream(request, allowClockRetry: true)
    }

    private func openStream(_ request: DeviceRequest, allowClockRetry: Bool) async throws -> AsyncThrowingStream<String, Error> {
        let urlRequest = try await signed(request)
        let (status, chunks) = try await exchange.stream(urlRequest)
        if (200..<300).contains(status) { return chunks }
        var body = ""
        for try await chunk in chunks {
            body += chunk
            if body.utf8.count > Self.streamErrorBodyLimit { break }
        }
        let response = HTTPExchangeResponse(status: status, body: Data(body.utf8))
        if allowClockRetry, status == 401, let serverTime = Self.serverTime(response.body) {
            lock.withLock { clockOffset = serverTime.timeIntervalSince(now()) }
            return try await openStream(request, allowClockRetry: false)
        }
        _ = try Self.check(response)
        throw DeviceAPIError.server(status: status, code: nil)
    }

    public func pair(origin: URL, access: ServiceAccessToken?, body: Data) async throws -> Data {
        guard let url = Self.url(origin: origin, path: "pair", rawQuery: "") else { throw DeviceAPIError.invalidResponse }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.httpBody = body
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        Self.apply(access: access, to: &urlRequest)
        let response = try await exchange.send(urlRequest)
        return try Self.check(response)
    }

    public func upload(path: String, header: String, grant: String, body: Data, contentType: String) async throws -> Data {
        guard let credentials = currentCredentials else { throw DeviceAPIError.server(status: 401, code: "DEVICE_NOT_PAIRED") }
        guard path.hasPrefix(Self.prefix) else { throw DeviceAPIError.invalidResponse }
        guard let url = Self.url(origin: credentials.origin, path: String(path.dropFirst(Self.prefix.count)), rawQuery: "") else {
            throw DeviceAPIError.invalidResponse
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.httpBody = body
        urlRequest.setValue(contentType, forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(grant, forHTTPHeaderField: header)
        Self.apply(access: credentials.access, to: &urlRequest)
        return try Self.check(try await exchange.send(urlRequest))
    }

    private func perform(_ request: DeviceRequest, allowClockRetry: Bool) async throws -> Data {
        let urlRequest = try await signed(request)
        let response = try await exchange.send(urlRequest)
        if allowClockRetry, response.status == 401, let serverTime = Self.serverTime(response.body) {
            lock.withLock { clockOffset = serverTime.timeIntervalSince(now()) }
            return try await perform(request, allowClockRetry: false)
        }
        return try Self.check(response)
    }

    private func signed(_ request: DeviceRequest) async throws -> URLRequest {
        let (credentials, offset) = lock.withLock { (self.credentials, clockOffset) }
        guard let credentials else { throw DeviceAPIError.server(status: 401, code: "DEVICE_NOT_PAIRED") }
        let rawQuery = Self.encode(request.query)
        guard let url = Self.url(origin: credentials.origin, path: request.path, rawQuery: rawQuery) else {
            throw DeviceAPIError.invalidResponse
        }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw DeviceAPIError.invalidResponse
        }
        let target = DeviceRequestTarget(
            method: request.method,
            authority: Self.authority(credentials.origin),
            path: components.percentEncodedPath,
            rawQuery: rawQuery,
            body: request.body,
            contentType: request.contentType
        )
        let parameters = DeviceSignatureParameters(
            deviceId: credentials.deviceId,
            created: Int64((now().addingTimeInterval(offset)).timeIntervalSince1970.rounded(.down)),
            nonce: request.nonce ?? DeviceSignature.newNonce()
        )
        let headers = try await DeviceSignature.headers(
            target: target,
            parameters: parameters,
            signer: credentials.deviceKey,
            confirmSigner: request.confirmSigner,
            confirmReason: request.confirmReason
        )
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = target.method
        urlRequest.httpBody = target.body
        for (name, value) in headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
        for (name, value) in request.extraHeaders { urlRequest.setValue(value, forHTTPHeaderField: name) }
        Self.apply(access: credentials.access, to: &urlRequest)
        return urlRequest
    }

    static func url(origin: URL, path: String, rawQuery: String) -> URL? {
        var text = origin.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        text += prefix + path
        if !rawQuery.isEmpty { text += "?" + rawQuery }
        return URL(string: text)
    }

    static func authority(_ origin: URL) -> String {
        let host = (origin.host ?? "").lowercased()
        if let port = origin.port { return "\(host):\(port)" }
        return host
    }

    static func encode(_ items: [URLQueryItem]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return items.map { item in
            let name = item.name.addingPercentEncoding(withAllowedCharacters: allowed) ?? item.name
            let value = (item.value ?? "").addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
            return "\(name)=\(value)"
        }.joined(separator: "&")
    }

    static func apply(access: ServiceAccessToken?, to request: inout URLRequest) {
        guard let access else { return }
        request.setValue(access.clientId, forHTTPHeaderField: "CF-Access-Client-Id")
        request.setValue(access.secret, forHTTPHeaderField: "CF-Access-Client-Secret")
    }

    private struct ErrorBody: Decodable {
        struct Inner: Decodable {
            let code: String
            let serverTime: String?
            let pairingCodeTtlSeconds: Int?
            let reason: String?
        }
        let error: Inner
    }

    static func check(_ response: HTTPExchangeResponse) throws -> Data {
        if (200..<300).contains(response.status) { return response.body }
        let body = (try? JSONDecoder().decode(ErrorBody.self, from: response.body))?.error
        throw DeviceAPIError.server(status: response.status, code: body?.code, pairingCodeTtlSeconds: body?.pairingCodeTtlSeconds, reason: body?.reason)
    }

    static func serverTime(_ body: Data) -> Date? {
        guard
            let parsed = try? JSONDecoder().decode(ErrorBody.self, from: body),
            parsed.error.code == "DEVICE_SIGNATURE_CLOCK_SKEW",
            let text = parsed.error.serverTime
        else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
