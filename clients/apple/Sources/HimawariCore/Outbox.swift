import Foundation

public enum OutboxState: String, Codable, Sendable, Equatable {
    case waiting
    case sending
    case failed
}

public struct OutboxItem: Codable, Sendable, Equatable, Identifiable {
    public var message: OutgoingMessage
    public var state: OutboxState
    public var attempts: Int
    public var lastErrorCode: String?
    public var id: String { message.messageId }
}

public protocol MessageSender: Sendable {
    func send(_ message: OutgoingMessage) async throws -> CommandOutcome
}

extension DeviceAPI: MessageSender {}

public enum OutboxSendResult: Sendable, Equatable {
    case delivered(messageId: String, threadRevision: Int)
    case retryLater
    case rejected(messageId: String, code: String?)

    public var deviceRevoked: Bool {
        if case .rejected(_, "DEVICE_REVOKED") = self { return true }
        return false
    }
}

public actor Outbox {
    public static let maximumConflictRetries = 3

    public static func unsentCount(in store: LocalStore, name: String = "outbox.json") -> Int? {
        guard store.contains(name) else { return 0 }
        guard let data = store.read(name), let items = try? JSONDecoder().decode([OutboxItem].self, from: data) else { return nil }
        return items.count
    }

    private let store: LocalStore
    private let name: String
    private var items: [OutboxItem]
    private var observers: [UUID: AsyncStream<[OutboxItem]>.Continuation] = [:]

    public init(store: LocalStore, name: String = "outbox.json") {
        self.store = store
        self.name = name
        if let data = store.read(name), let decoded = try? JSONDecoder().decode([OutboxItem].self, from: data) {
            items = decoded.map { item in
                var item = item
                if item.state == .sending { item.state = .waiting }
                return item
            }
        } else {
            items = []
        }
    }

    public var pending: [OutboxItem] { items }

    public func updates() -> AsyncStream<[OutboxItem]> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<[OutboxItem]>.makeStream()
        observers[id] = continuation
        continuation.yield(items)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeObserver(id) }
        }
        return stream
    }

    private func removeObserver(_ id: UUID) {
        observers[id] = nil
    }

    @discardableResult
    public func enqueue(_ message: OutgoingMessage) -> OutboxItem {
        let item = OutboxItem(message: message, state: .waiting, attempts: 0, lastErrorCode: nil)
        items.append(item)
        persist()
        return item
    }

    public func retry(_ messageId: String) {
        guard let index = items.firstIndex(where: { $0.id == messageId }) else { return }
        items[index].state = .waiting
        items[index].attempts = 0
        items[index].lastErrorCode = nil
        persist()
    }

    public func discard(_ messageId: String) {
        items.removeAll { $0.id == messageId }
        persist()
    }

    public func flush(
        using sender: MessageSender,
        latestRevision: @Sendable (String) async -> Int?
    ) async -> [OutboxSendResult] {
        var results: [OutboxSendResult] = []
        var conflictRetries: [String: Int] = [:]
        while let index = items.firstIndex(where: { $0.state == .waiting }) {
            items[index].state = .sending
            items[index].attempts += 1
            persist()
            let message = items[index].message
            let result: OutboxSendResult
            do {
                switch try await sender.send(message) {
                case let .accepted(revision, _):
                    result = .delivered(messageId: message.messageId, threadRevision: revision)
                case let .conflict(reason, latest):
                    let revision: Int?
                    if let latest { revision = latest.revision } else { revision = await latestRevision(message.threadId) }
                    if let revision, revision != message.expectedRevision, conflictRetries[message.messageId, default: 0] < Self.maximumConflictRetries {
                        conflictRetries[message.messageId, default: 0] += 1
                        update(message.messageId) {
                            $0.message.expectedRevision = revision
                            $0.state = .waiting
                        }
                        continue
                    }
                    result = .rejected(messageId: message.messageId, code: reason)
                }
            } catch let error as DeviceAPIError {
                if case let .server(status, code, _) = error, (400..<500).contains(status), status != 408, status != 429 {
                    result = .rejected(messageId: message.messageId, code: code)
                } else {
                    result = .retryLater
                }
            } catch {
                result = .retryLater
            }
            switch result {
            case .delivered:
                items.removeAll { $0.id == message.messageId }
                persist()
                results.append(result)
            case let .rejected(_, code):
                update(message.messageId) {
                    $0.state = .failed
                    $0.lastErrorCode = code
                }
                results.append(result)
            case .retryLater:
                update(message.messageId) { $0.state = .waiting }
                results.append(result)
                return results
            }
        }
        return results
    }

    private func update(_ messageId: String, _ change: (inout OutboxItem) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == messageId }) else { return }
        change(&items[index])
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(items) { try? store.write(name, data) }
        for observer in observers.values { observer.yield(items) }
    }
}
