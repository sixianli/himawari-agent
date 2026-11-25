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
