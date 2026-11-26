import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPExchangeResponse: Sendable {
    public let status: Int
    public let body: Data
    public let headers: [String: String]

    public init(status: Int, body: Data, headers: [String: String] = [:]) {
        self.status = status
        self.body = body
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { first, _ in first })
    }

    public func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }
}

public protocol HTTPExchange: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPExchangeResponse
    func stream(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<String, Error>)
}

public enum HTTPExchangeError: Error, Sendable {
    case notHTTP
    case streamingUnsupported
}

public struct URLSessionExchange: HTTPExchange {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> HTTPExchangeResponse {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw HTTPExchangeError.notHTTP }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String { headers[key] = value }
        }
        return HTTPExchangeResponse(status: http.statusCode, body: data, headers: headers)
    }

    public func stream(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<String, Error>) {
        #if canImport(FoundationNetworking)
        throw HTTPExchangeError.streamingUnsupported
        #else
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else { throw HTTPExchangeError.notHTTP }
        let chunks = AsyncThrowingStream<String, Error> { continuation in
            let task = Task {
                do {
                    var line: [UInt8] = []
                    for try await byte in bytes {
                        line.append(byte)
                        if byte == 0x0A {
                            continuation.yield(String(decoding: line, as: UTF8.self))
                            line.removeAll(keepingCapacity: true)
                        }
                    }
                    if !line.isEmpty { continuation.yield(String(decoding: line, as: UTF8.self)) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (http.statusCode, chunks)
        #endif
    }
}
