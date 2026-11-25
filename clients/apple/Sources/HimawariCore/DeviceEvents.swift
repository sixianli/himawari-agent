import Foundation

public enum DeviceStreamEvent: Sendable, Equatable {
    case connected
    case thread(ThreadEvent)
    case executionText(ExecutionText)
    case executionChanged(threadId: String, runId: String)
    case notificationDeliver(DeviceNotification)
    case notificationWithdraw(id: String)
    case resyncRequired
    case deviceActions
    case sessionInvalid
    case unavailable
    case disconnected
}

public enum DeviceEventDecoder {
    public static let notificationEvents: Set<String> = ["notification.deliver", "notification.withdraw"]

    public static func decode(_ event: ServerSentEvent) -> DeviceStreamEvent? {
        let data = Data(event.data.utf8)
        switch event.event {
        case "message", "thread.execution_text", "thread.execution_changed":
            struct Head: Decodable { let type: String }
            guard let head = try? JSONDecoder().decode(Head.self, from: data) else { return nil }
            switch head.type {
            case "thread.event":
                return (try? JSONDecoder().decode(GatewayEnvelope<ThreadEvent>.self, from: data)).map { .thread($0.payload) }
            case "thread.execution_text":
                return (try? JSONDecoder().decode(GatewayEnvelope<ExecutionText>.self, from: data)).map { .executionText($0.payload) }
            case "thread.execution_changed":
                struct Changed: Decodable { let threadId: String; let runId: String }
                return (try? JSONDecoder().decode(GatewayEnvelope<Changed>.self, from: data)).map {
                    .executionChanged(threadId: $0.payload.threadId, runId: $0.payload.runId)
                }
            default:
                return nil
            }
        case "notification.deliver":
            return (try? JSONDecoder().decode(DeviceNotification.self, from: data)).map { .notificationDeliver($0) }
        case "notification.withdraw":
            struct Withdraw: Decodable { let id: String }
            return (try? JSONDecoder().decode(Withdraw.self, from: data)).map { .notificationWithdraw(id: $0.id) }
        case "device.actions":
            return .deviceActions
        case "thread.snapshot_required":
            return .resyncRequired
        case "thread.execution_unavailable":
            return .unavailable
        case "gateway.stream_error":
            struct Body: Decodable { let code: String }
            let code = (try? JSONDecoder().decode(Body.self, from: data))?.code
            return code == "IDENTITY_SESSION_INVALID" ? .sessionInvalid : .disconnected
        default:
            return nil
        }
    }
}

public protocol CursorStore: Sendable {
    func load() -> String?
    func save(_ cursor: String?)
}

public final class DeviceEventStream: @unchecked Sendable {
    private let http: DeviceHTTPClient
    private let path: String
    private let cursors: CursorStore?
    private let heartbeat: @Sendable () -> TimeInterval
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var wake: CheckedContinuation<Void, Never>?
    private var pauseNumber = 0
    private var wakePending = false
    private var restartRequested = false
    private var continuation: AsyncStream<DeviceStreamEvent>.Continuation?

    public init(http: DeviceHTTPClient, path: String = "stream", cursors: CursorStore?, heartbeat: @escaping @Sendable () -> TimeInterval) {
        self.http = http
        self.path = path
        self.cursors = cursors
        self.heartbeat = heartbeat
    }

    public func start() -> AsyncStream<DeviceStreamEvent> {
        stop()
        let (stream, continuation) = AsyncStream<DeviceStreamEvent>.makeStream()
        lock.withLock { self.continuation = continuation }
        let task = Task { [weak self] in
            guard let self else { return }
            await self.run(continuation: continuation)
        }
        lock.withLock { self.task = task }
        continuation.onTermination = { [weak self] _ in self?.stop() }
        return stream
    }

    public func stop() {
        let (task, continuation) = lock.withLock { () -> (Task<Void, Never>?, AsyncStream<DeviceStreamEvent>.Continuation?) in
            defer {
                self.task = nil
                self.continuation = nil
            }
            return (self.task, self.continuation)
        }
        task?.cancel()
        continuation?.finish()
    }

    public func restartConnection() {
        lock.withLock { restartRequested = true }
        reconnectNow()
    }

    static let silenceAllowance: TimeInterval = 5

    public func reconnectNow() {
        let pending = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            defer { wake = nil }
            if wake == nil { wakePending = true }
            return wake
        }
        pending?.resume()
    }

    private func endPause(_ number: Int) {
        let pending = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            guard pauseNumber == number else { return nil }
            defer { wake = nil }
            return wake
        }
        pending?.resume()
    }

    private func run(continuation: AsyncStream<DeviceStreamEvent>.Continuation) async {
        var failures = 0
        var droppedAt: Date?
        while !Task.isCancelled {
            var query: [URLQueryItem] = []
            if let cursor = cursors?.load() { query.append(URLQueryItem(name: "after", value: cursor)) }
            var ending: StreamEnding
            lock.withLock { restartRequested = false }
            do {
                guard let chunks = try await open(DeviceRequest(method: "GET", path: path, query: query)) else {
                    continue
                }
                lock.withLock { wakePending = false }
                continuation.yield(.connected)
                let openedAt = Date()
                if let droppedAt {
                    StreamDiagnostics.shared.note(.recovered(path: path, offlineSeconds: openedAt.timeIntervalSince(droppedAt)))
                }
                droppedAt = nil
                let deadline = LivenessDeadline(window: { [heartbeat] in heartbeat() * 2 + Self.silenceAllowance })
                ending = try await consume(chunks, deadline: deadline, continuation: continuation)
                failures = deadline.heard ? 0 : failures + 1
                if case let .reconnect(reason) = ending {
                    StreamDiagnostics.shared.note(.dropped(path: path, reason: reason, connectedSeconds: Date().timeIntervalSince(openedAt)))
                }
            } catch let error as DeviceAPIError where error.isRevoked {
                continuation.yield(.sessionInvalid)
                ending = .stop
            } catch let DeviceAPIError.server(status, code, _, _) {
                StreamDiagnostics.shared.note(.refused(path: path, status: status, code: code))
                failures += 1
                ending = .reconnect(.failed)
            } catch {
                failures += 1
                ending = .reconnect(.failed)
            }
            if Task.isCancelled { break }
            guard case let .reconnect(reason) = ending else { break }
            if reason.planned {
                continue
            }
            if droppedAt == nil { droppedAt = Date() }
            continuation.yield(.disconnected)
            await pause(seconds: Self.backoff(failures: failures))
        }
        continuation.finish()
    }

    private enum StreamEnding: Sendable {
        case stop
        case reconnect(StreamDropReason)
    }

    private func takeRestart() -> Bool {
        lock.withLock {
            defer { restartRequested = false }
            return restartRequested
        }
    }

    private func consume(_ chunks: AsyncThrowingStream<String, Error>, deadline: LivenessDeadline, continuation: AsyncStream<DeviceStreamEvent>.Continuation) async throws -> StreamEnding {
        return try await withThrowingTaskGroup(of: StreamEnding.self) { group in
            group.addTask {
                var parser = ServerSentEventParser()
                for try await chunk in chunks {
                    deadline.touch()
                    for event in parser.feed(chunk) {
                        if let id = event.id, !id.isEmpty, !DeviceEventDecoder.notificationEvents.contains(event.event) { self.cursors?.save(id) }
                        if event.event == "device.reconnect" { return .reconnect(.serverRotated) }
                        guard let decoded = DeviceEventDecoder.decode(event) else { continue }
                        if decoded == .resyncRequired { self.cursors?.save(nil) }
                        continuation.yield(decoded)
                        if decoded == .sessionInvalid || decoded == .unavailable { return .stop }
                    }
                }
                return .reconnect(.closed)
            }
            group.addTask {
                while !Task.isCancelled {
                    try await Task.sleep(nanoseconds: Self.checkNanoseconds)
                    if self.takeRestart() { return .reconnect(.restarted) }
                    if deadline.expired() { return .reconnect(.silent) }
                }
                return .reconnect(.closed)
            }
            do {
                let result = try await group.next() ?? .reconnect(.closed)
                group.cancelAll()
                return result
            } catch {
                group.cancelAll()
                return .reconnect(.failed)
            }
        }
    }

    static let checkNanoseconds: UInt64 = 250_000_000

    private func open(_ request: DeviceRequest) async throws -> AsyncThrowingStream<String, Error>? {
        try await withThrowingTaskGroup(of: AsyncThrowingStream<String, Error>?.self) { group in
            group.addTask { try await self.http.openStream(request) }
            group.addTask {
                while !Task.isCancelled {
                    try await Task.sleep(nanoseconds: Self.checkNanoseconds)
                    if self.takeRestart() { return nil }
                }
                throw CancellationError()
            }
            defer { group.cancelAll() }
            return try await group.next() ?? nil
        }
    }

    private func pause(seconds: TimeInterval) async {
        await withCheckedContinuation { (wakeUp: CheckedContinuation<Void, Never>) in
            let number = lock.withLock { () -> Int? in
                if wakePending {
                    wakePending = false
                    return nil
                }
                pauseNumber += 1
                wake = wakeUp
                return pauseNumber
            }
            guard let number else {
                wakeUp.resume()
                return
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                self?.endPause(number)
            }
        }
    }

    public static func backoff(failures: Int) -> TimeInterval {
        guard failures > 0 else { return 0.5 }
        return min(30, pow(2, Double(min(failures, 5))) * 0.5)
    }
}

final class LivenessDeadline: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()
    private let window: @Sendable () -> TimeInterval

    init(window: @escaping @Sendable () -> TimeInterval) {
        self.window = window
    }

    private var touched = false

    var heard: Bool {
        lock.withLock { touched }
    }

    func touch() {
        lock.withLock {
            last = Date()
            touched = true
        }
    }

    func expired() -> Bool {
        lock.withLock { Date().timeIntervalSince(last) > window() }
    }

}
