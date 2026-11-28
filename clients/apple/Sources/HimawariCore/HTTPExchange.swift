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

public struct HTTPByteResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let chunks: AsyncThrowingStream<Data, Error>

    public init(status: Int, headers: [String: String], chunks: AsyncThrowingStream<Data, Error>) {
        self.status = status
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { first, _ in first })
        self.chunks = chunks
    }

    public func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }
}

public protocol HTTPExchange: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPExchangeResponse
    func stream(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<String, Error>)
    func bytes(_ request: URLRequest) async throws -> HTTPByteResponse
}

extension HTTPExchange {
    public func bytes(_ request: URLRequest) async throws -> HTTPByteResponse {
        throw HTTPExchangeError.streamingUnsupported
    }
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

    public func bytes(_ request: URLRequest) async throws -> HTTPByteResponse {
        #if canImport(FoundationNetworking)
        throw HTTPExchangeError.streamingUnsupported
        #else
        let receiver = ByteReceiver()
        let task = session.dataTask(with: request)
        task.delegate = receiver
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                receiver.begin(task: task, continuation: continuation)
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
        #endif
    }
}

#if !canImport(FoundationNetworking)
private final class ByteReceiver: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var opened: CheckedContinuation<HTTPByteResponse, Error>?
    private var chunks: AsyncThrowingStream<Data, Error>.Continuation?
    private var stream: AsyncThrowingStream<Data, Error>?

    func begin(task: URLSessionDataTask, continuation: CheckedContinuation<HTTPByteResponse, Error>) {
        let stream = AsyncThrowingStream<Data, Error> { chunks in
            chunks.onTermination = { _ in task.cancel() }
            self.lock.withLock { self.chunks = chunks }
        }
        lock.withLock {
            self.stream = stream
            opened = continuation
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse) async -> URLSession.ResponseDisposition {
        let (opened, stream) = lock.withLock { () -> (CheckedContinuation<HTTPByteResponse, Error>?, AsyncThrowingStream<Data, Error>?) in
            defer { self.opened = nil }
            return (self.opened, self.stream)
        }
        guard let opened, let stream else { return .cancel }
        guard let http = response as? HTTPURLResponse else {
            opened.resume(throwing: HTTPExchangeError.notHTTP)
            return .cancel
        }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { headers[name] = value }
        }
        opened.resume(returning: HTTPByteResponse(status: http.statusCode, headers: headers, chunks: stream))
        return .allow
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        _ = lock.withLock { chunks }?.yield(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let (opened, chunks) = lock.withLock { () -> (CheckedContinuation<HTTPByteResponse, Error>?, AsyncThrowingStream<Data, Error>.Continuation?) in
            defer {
                self.opened = nil
                self.chunks = nil
            }
            return (self.opened, self.chunks)
        }
        if let opened {
            opened.resume(throwing: error ?? HTTPExchangeError.notHTTP)
        }
        if let error { chunks?.finish(throwing: error) } else { chunks?.finish() }
    }
}
#endif
