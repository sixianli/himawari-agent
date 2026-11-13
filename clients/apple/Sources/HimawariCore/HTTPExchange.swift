import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct HTTPExchangeResponse: Sendable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
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
        return HTTPExchangeResponse(status: http.statusCode, body: data)
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
