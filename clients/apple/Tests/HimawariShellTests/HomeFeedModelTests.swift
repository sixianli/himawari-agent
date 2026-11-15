import Foundation
import HimawariCore
import Testing
@testable import HimawariShell

private actor FakeSource: HomeFeedSource {
    enum Mode {
        case works
        case fails
        case declined
    }

    private(set) var acted: [String] = []
    var mode: Mode

    init(mode: Mode) {
        self.mode = mode
    }

    func setMode(_ next: Mode) {
        mode = next
    }

    func read(locale: HomeLocale) async throws -> HomeFeedSnapshot {
        HomeFeedSnapshot(items: [], awaitingCount: 0, upcoming: [], revision: "r2", generatedAt: "2026-11-13T00:00:00Z")
    }

    func act(_ item: HomeFeedItem, action: HomeFeedAction, revision: String) async throws -> HomeActOutcome {
        acted.append("\(item.key):\(action.action):\(revision)")
        switch mode {
        case .works: return HomeActOutcome(message: "ok", undo: HomeFeedAction(action: "undo", label: "撤销", polarity: .neutral))
        case .fails: throw DeviceAPIError.server(status: 500, code: nil)
        case .declined: throw OwnerPresenceError.declined
        }
    }
}

@MainActor
struct HomeFeedModelTests {
    private let item = HomeFeedItem(
        key: "insight:a",
        kind: "heads_up",
        awaitsOwner: true,
        sentence: "a",
        target: .init(type: "mail", id: "a", threadId: nil),
        source: .init(type: "mail", from: nil, label: nil, threadId: nil, at: "2026-11-13T00:00:00Z"),
        createdAt: "2026-11-13T00:00:00Z",
        actions: [HomeFeedAction(action: "done", label: "好", polarity: .positive, binding: "b1")]
    )

    private func model(_ source: FakeSource) -> HomeFeedModel {
        let snapshot = HomeFeedSnapshot(items: [item], awaitingCount: 1, upcoming: [], revision: "r1", generatedAt: "2026-11-13T00:00:00Z")
        return HomeFeedModel(snapshot: snapshot, source: source)
    }

    @Test func aSuccessfulActionSettlesTheItemAndSendsTheSnapshotRevision() async throws {
        let source = FakeSource(mode: .works)
        let model = model(source)
        await model.decide(item, action: item.actions[0], approvals: nil)
        #expect(await source.acted == ["insight:a:done:r1"])
        #expect(model.toast?.message == "ok")
    }

    @Test func aFailedActionKeepsTheItemAndTellsTheOwner() async throws {
        let source = FakeSource(mode: .fails)
        let model = model(source)
        await model.decide(item, action: item.actions[0], approvals: nil)
        #expect(!model.settled.contains(item.key))
        #expect(model.toast != nil)
        #expect(model.toast?.undo == nil)
    }

    @Test func decliningOwnerPresenceIsNotAFailure() async throws {
        let source = FakeSource(mode: .declined)
        let model = model(source)
        await model.decide(item, action: item.actions[0], approvals: nil)
        #expect(model.toast == nil)
        #expect(!model.settled.contains(item.key))
    }

    @Test func anItemWithoutASourceCannotBeActedOn() {
        let snapshot = HomeFeedSnapshot(items: [item], awaitingCount: 1, upcoming: [], revision: "r1", generatedAt: "2026-11-13T00:00:00Z")
        let model = HomeFeedModel(snapshot: snapshot, source: nil)
        #expect(!model.canAct(item, approvals: nil))
    }
}
