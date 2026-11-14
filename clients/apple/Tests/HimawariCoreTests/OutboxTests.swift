import Foundation
import Testing
@testable import HimawariCore

final class ScriptedSender: MessageSender, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [Result<CommandOutcome, Error>]
    private(set) var sent: [OutgoingMessage] = []

    init(_ script: [Result<CommandOutcome, Error>]) {
        self.script = script
    }

    func send(_ message: OutgoingMessage) async throws -> CommandOutcome {
        let next = lock.withLock { () -> Result<CommandOutcome, Error> in
            sent.append(message)
            return script.isEmpty ? .failure(URLError(.notConnectedToInternet)) : script.removeFirst()
        }
        return try next.get()
    }
}

@Suite struct OutboxTests {
    private func message(_ text: String = "你好", revision: Int = 1) -> OutgoingMessage {
        OutgoingMessage(threadId: "t1", expectedRevision: revision, text: text, createdAt: Date(timeIntervalSince1970: 0))
    }

    @Test func deliveredMessagesLeaveTheQueue() async {
        let outbox = Outbox(store: MemoryLocalStore())
        let item = await outbox.enqueue(message())
        let sender = ScriptedSender([.success(.accepted(threadRevision: 2, replayed: false))])
        let results = await outbox.flush(using: sender) { _ in nil }
        #expect(results == [.delivered(messageId: item.id, threadRevision: 2)])
        #expect(await outbox.pending.isEmpty)
    }

    @Test func networkFailureKeepsMessageAndStopsInOrder() async {
        let outbox = Outbox(store: MemoryLocalStore())
        await outbox.enqueue(message("一"))
        await outbox.enqueue(message("二"))
        let sender = ScriptedSender([.failure(URLError(.timedOut))])
        let results = await outbox.flush(using: sender) { _ in nil }
        #expect(results == [.retryLater])
        #expect(sender.sent.map(\.text) == ["一"])
        #expect(await outbox.pending.map(\.state) == [.waiting, .waiting])
    }

    @Test func retriedSendReusesTheSameMessageId() async {
        let outbox = Outbox(store: MemoryLocalStore())
        await outbox.enqueue(message())
        let sender = ScriptedSender([.failure(URLError(.timedOut)), .success(.accepted(threadRevision: 2, replayed: true))])
        _ = await outbox.flush(using: sender) { _ in nil }
        _ = await outbox.flush(using: sender) { _ in nil }
        #expect(sender.sent.count == 2)
        #expect(sender.sent[0].messageId == sender.sent[1].messageId)
    }

    @Test func conflictRefreshesRevisionThenSucceeds() async {
        let outbox = Outbox(store: MemoryLocalStore())
        await outbox.enqueue(message(revision: 1))
        let sender = ScriptedSender([
            .success(.conflict(reasonCode: "THREAD_REVISION_CONFLICT", latest: nil)),
            .success(.accepted(threadRevision: 6, replayed: false)),
        ])
        let results = await outbox.flush(using: sender) { _ in 5 }
        #expect(sender.sent.map(\.expectedRevision) == [1, 5])
        #expect(results.count == 1)
        #expect(await outbox.pending.isEmpty)
    }

    @Test func earlierNetworkFailuresDoNotUseUpConflictRetries() async {
        let outbox = Outbox(store: MemoryLocalStore())
        await outbox.enqueue(message())
        let offline = ScriptedSender([.failure(URLError(.timedOut))])
        for _ in 0..<4 { _ = await outbox.flush(using: offline) { _ in nil } }
        let sender = ScriptedSender([
            .success(.conflict(reasonCode: "THREAD_REVISION_CONFLICT", latest: nil)),
            .success(.accepted(threadRevision: 3, replayed: false)),
        ])
        let results = await outbox.flush(using: sender) { _ in 2 }
        #expect(results.count == 1)
        #expect(sender.sent.map(\.expectedRevision) == [1, 2])
        #expect(await outbox.pending.isEmpty)
    }

    @Test func conflictWithoutNewRevisionFails() async {
        let outbox = Outbox(store: MemoryLocalStore())
        let item = await outbox.enqueue(message(revision: 3))
        let sender = ScriptedSender([.success(.conflict(reasonCode: "THREAD_ARCHIVED", latest: nil))])
        let results = await outbox.flush(using: sender) { _ in 3 }
        #expect(results == [.rejected(messageId: item.id, code: "THREAD_ARCHIVED")])
        #expect(await outbox.pending.first?.state == .failed)
    }

    @Test func clientErrorsAreFailedButRateLimitsRetry() async {
        let outbox = Outbox(store: MemoryLocalStore())
        let first = await outbox.enqueue(message("一"))
        await outbox.enqueue(message("二"))
        let sender = ScriptedSender([
            .failure(DeviceAPIError.server(status: 400, code: "REQUEST_INVALID")),
            .failure(DeviceAPIError.server(status: 429, code: "DEVICE_NONCE_STORE_FULL")),
        ])
        let results = await outbox.flush(using: sender) { _ in nil }
        #expect(results == [.rejected(messageId: first.id, code: "REQUEST_INVALID"), .retryLater])
        #expect(await outbox.pending.map(\.state) == [.failed, .waiting])
    }

    @Test func onlyARevokedDeviceEndsTheSessionNotANetworkFailure() async {
        let revoked = Outbox(store: MemoryLocalStore())
        await revoked.enqueue(message())
        let refused = await revoked.flush(using: ScriptedSender([.failure(DeviceAPIError.server(status: 403, code: "DEVICE_REVOKED"))])) { _ in nil }
        #expect(refused.contains { $0.deviceRevoked })

        let offline = Outbox(store: MemoryLocalStore())
        await offline.enqueue(message())
        let failed = await offline.flush(using: ScriptedSender([.failure(URLError(.timedOut))])) { _ in nil }
        #expect(failed == [.retryLater])
        #expect(!failed.contains { $0.deviceRevoked })

        let invalid = Outbox(store: MemoryLocalStore())
        await invalid.enqueue(message())
        let rejected = await invalid.flush(using: ScriptedSender([.failure(DeviceAPIError.server(status: 400, code: "REQUEST_INVALID"))])) { _ in nil }
        #expect(!rejected.contains { $0.deviceRevoked })
    }

    @Test func failedMessageCanBeRetriedByHand() async {
        let outbox = Outbox(store: MemoryLocalStore())
        let item = await outbox.enqueue(message())
        _ = await outbox.flush(using: ScriptedSender([.failure(DeviceAPIError.server(status: 400, code: nil))])) { _ in nil }
        await outbox.retry(item.id)
        let results = await outbox.flush(using: ScriptedSender([.success(.accepted(threadRevision: 2, replayed: false))])) { _ in nil }
        #expect(results == [.delivered(messageId: item.id, threadRevision: 2)])
    }

    @Test func queueSurvivesRestartAndSendingBecomesWaiting() async throws {
        let store = MemoryLocalStore()
        let outbox = Outbox(store: store)
        await outbox.enqueue(message())
        var items = try JSONDecoder().decode([OutboxItem].self, from: try #require(store.read("outbox.json")))
        items[0].state = .sending
        try store.write("outbox.json", try JSONEncoder().encode(items))
        let reopened = Outbox(store: store)
        #expect(await reopened.pending.map(\.state) == [.waiting])
        #expect(await reopened.pending.first?.message.text == "你好")
    }
}
