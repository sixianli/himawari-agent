import Foundation

public enum StreamDropReason: String, Sendable, Equatable {
    case serverRotated
    case restarted
    case silent
    case closed
    case failed

    public var planned: Bool {
        self == .serverRotated || self == .restarted
    }
}

public enum StreamProblem: Sendable, Equatable {
    case notOpened(path: String, streamConnections: Int)
    case refused(path: String, status: Int, code: String?)
    case dropped(path: String, reason: StreamDropReason, connectedSeconds: TimeInterval)
    case recovered(path: String, offlineSeconds: TimeInterval)
}

public final class StreamDiagnostics: @unchecked Sendable {
    public static let shared = StreamDiagnostics()

    private let lock = NSLock()
    private var observer: (@Sendable (StreamProblem) -> Void)?
    private var last: StreamProblem?

    public func observe(_ observer: (@Sendable (StreamProblem) -> Void)?) {
        lock.withLock { self.observer = observer }
    }

    public var lastProblem: StreamProblem? {
        lock.withLock { last }
    }

    public func reset() {
        lock.withLock { last = nil }
    }

    public func note(_ problem: StreamProblem) {
        let report = lock.withLock { () -> (@Sendable (StreamProblem) -> Void)? in
            last = problem
            return observer
        }
        report?(problem)
    }
}

public struct StreamDropReport: Sendable, Equatable {
    public let reason: String
    public let connectedSeconds: TimeInterval?
    public var status: Int?
    public var networkError: Int?
    public let droppedAt: Date
    public var attempts = 0

    public init(reason: String, connectedSeconds: TimeInterval? = nil, status: Int? = nil, networkError: Int? = nil, droppedAt: Date) {
        self.reason = reason
        self.connectedSeconds = connectedSeconds
        self.status = status
        self.networkError = networkError
        self.droppedAt = droppedAt
    }

    public func query(at now: Date) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "lastDrop", value: reason)]
        if let connectedSeconds { items.append(URLQueryItem(name: "lastConnected", value: String(Int(connectedSeconds.rounded())))) }
        if let status { items.append(URLQueryItem(name: "lastStatus", value: String(status))) }
        if let networkError { items.append(URLQueryItem(name: "lastError", value: String(networkError))) }
        items.append(URLQueryItem(name: "offline", value: String(max(0, Int(now.timeIntervalSince(droppedAt).rounded())))))
        items.append(URLQueryItem(name: "attempts", value: String(attempts)))
        return items
    }
}
