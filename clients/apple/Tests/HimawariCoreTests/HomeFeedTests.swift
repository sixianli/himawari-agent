import Foundation
import HimawariCore
import Testing

struct HomeFeedTests {
    private func fixture() throws -> HomeFeedSnapshot {
        let url = try #require(Bundle.module.url(forResource: "home-snapshot", withExtension: "json", subdirectory: "Fixtures"))
        return try HomeFeedSnapshot.decode(Data(contentsOf: url))
    }

    private func item(_ key: String, awaits: Bool, actions: [HomeFeedAction] = HomeFeedTests.pair) -> HomeFeedItem {
        HomeFeedItem(
            key: key,
            kind: awaits ? "heads_up" : "done",
            awaitsOwner: awaits,
            sentence: key,
            target: .init(type: "memory", id: key, threadId: nil),
            source: .init(type: "memory", from: nil, label: nil, threadId: nil, at: "2026-11-13T00:00:00Z"),
            createdAt: "2026-11-13T00:00:00Z",
            actions: awaits ? actions : []
        )
    }

    private static let pair = [
        HomeFeedAction(action: "done", label: "完成", polarity: .positive, binding: "b-done"),
        HomeFeedAction(action: "mute", label: "不再提醒", polarity: .negative, binding: "b-mute"),
    ]

    private func snapshot(_ items: [HomeFeedItem], awaiting: Int? = nil, incomplete: [String] = []) -> HomeFeedSnapshot {
        HomeFeedSnapshot(
            items: items,
            awaitingCount: awaiting ?? items.filter(\.awaitsOwner).count,
            incompleteSources: incomplete,
            upcoming: [],
            revision: "r",
            generatedAt: "2026-11-13T00:00:00Z"
        )
    }

    @Test func decodesTheServerSnapshotShape() throws {
        let home = try fixture()
        #expect(home.items.map(\.key) == ["insight:mail-42", "approval:apr-7", "run:run-3"])
        #expect(home.items[1].approvalId == "apr-7")
        #expect(home.items[1].threadId == "thr-osaka")
        #expect(home.items[1].choice?.confirm.buttonLabel == "看内容再定")
        #expect(home.items[1].choice?.decline?.buttonLabel == "不同意")
        #expect(home.items[2].itemKind == .running)
        #expect(home.items[0].subtitle == "周五会议改时间")
        #expect(home.upcoming.first?.due == HomeTimestamp.parse("2026-11-13T12:00:00Z"))
    }

    @Test func keepsTheBindingTheServerGaveEachAction() throws {
        let home = try fixture()
        let actions = try #require(home.items.first { $0.key == "insight:mail-42" }).actions
        #expect(!actions.isEmpty)
        #expect(actions.allSatisfy { $0.binding == "b-insight:mail-42-\($0.action)" })
    }

    @Test func rejectsAGatewayEnvelopeBecauseTheDeviceRouteSendsOnlyThePayload() throws {
        let url = try #require(Bundle.module.url(forResource: "home-snapshot", withExtension: "json", subdirectory: "Fixtures"))
        let payload = try String(contentsOf: url, encoding: .utf8)
        #expect(throws: Never.self) { try HomeFeedSnapshot.decode(Data(payload.utf8)) }
        let envelope = Data(#"{"type":"home.snapshot","payload":\#(payload)}"#.utf8)
        #expect(throws: (any Error).self) { try HomeFeedSnapshot.decode(envelope) }
    }

    @Test func anActionWithoutABindingCannotBeSentToHomeAct() {
        let reconnect = HomeFeedAction(action: "reconnect", label: "重新连接", polarity: .positive)
        let unbound = item("connection:mail", awaits: true, actions: [reconnect])
        #expect(unbound.choice == nil)
        #expect(HomeLayout(snapshot([unbound])).lead == nil)
    }

    @Test func anApprovalKeepsItsButtonsBecauseItIsAnsweredThroughTheApprovalRoute() {
        let approval = HomeFeedItem(
            key: "approval:a1",
            kind: "approval",
            awaitsOwner: true,
            sentence: "a",
            target: .init(type: "approval", id: "a1", threadId: nil),
            source: .init(type: "conversation", from: nil, label: nil, threadId: nil, at: "2026-11-13T00:00:00Z"),
            createdAt: "2026-11-13T00:00:00Z",
            actions: [HomeFeedAction(action: "approved", label: "同意", polarity: .positive)]
        )
        #expect(approval.choice?.confirm.action == "approved")
    }

    @Test func homeRequestIdsStartWithALetterOrDigitAndStayInsideTheServerCharacterSet() {
        for _ in 0 ..< 2000 {
            let id = HomeRequestId.make()
            #expect(id.count <= 128)
            #expect(id.first?.isLetter == true || id.first?.isNumber == true)
            #expect(id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._:-".contains($0)) })
        }
    }

    @Test func keepsTheServerOrderExactly() {
        let keys = ["c", "a", "e", "b", "d"]
        let items = keys.enumerated().map { item($1, awaits: $0 < 3) }
        let layout = HomeLayout(snapshot(items))
        #expect(layout.lead?.key == "c")
        #expect(([layout.lead].compactMap { $0 } + layout.rows).map(\.key) == keys)
    }

    @Test func theLeadIsTheFirstItemThatWaitsForTheOwner() {
        let layout = HomeLayout(snapshot([item("did", awaits: false), item("ask", awaits: true)]))
        #expect(layout.lead?.key == "ask")
        #expect(layout.rows.map(\.key) == ["did"])
    }

    @Test func anItemWithoutButtonsNeverBecomesTheLead() {
        let layout = HomeLayout(snapshot([item("bare", awaits: true, actions: []), item("ask", awaits: true)]))
        #expect(layout.lead?.key == "ask")
        #expect(layout.rows.map(\.key) == ["bare"])
    }

    @Test func settlingOneLetsTheNextMoveUpAndLowersTheBadge() {
        let home = snapshot([item("one", awaits: true), item("two", awaits: true), item("did", awaits: false)])
        #expect(HomeLayout(home).badge == 2)
        let after = HomeLayout(home, settled: ["one"])
        #expect(after.lead?.key == "two")
        #expect(after.rows.map(\.key) == ["did"])
        #expect(after.badge == 1)
    }

    @Test func noBadgeWhenNothingWaits() {
        let layout = HomeLayout(snapshot([item("did", awaits: false)]))
        #expect(layout.badge == nil)
        #expect(layout.lead == nil)
        #expect(!layout.isQuiet)
        #expect(HomeLayout(snapshot([])).isQuiet)
    }

    @Test func noBadgeWhenASourceCouldNotBeRead() {
        let layout = HomeLayout(snapshot([item("one", awaits: true)], incomplete: ["mail"]))
        #expect(layout.badge == nil)
        #expect(layout.lead?.key == "one")
    }

    @Test func theBadgeUsesTheServerCountEvenWhenTheListIsCut() {
        let layout = HomeLayout(snapshot([item("one", awaits: true)], awaiting: 30))
        #expect(layout.badge == 30)
    }

    @Test func choicePutsTheNegativeOnTheLeftAndFallsBackToNeutral() {
        let snooze = HomeFeedAction(action: "snooze", label: "稍后再提醒", polarity: .neutral, binding: "b")
        let done = HomeFeedAction(action: "done", label: "完成", polarity: .positive, binding: "b")
        let dismiss = HomeFeedAction(action: "dismiss", label: "知道了", polarity: .negative, binding: "b")
        #expect(item("x", awaits: true, actions: [snooze, done, dismiss]).choice?.decline == dismiss)
        #expect(item("x", awaits: true, actions: [snooze, done]).choice?.decline == snooze)
        #expect(item("x", awaits: true, actions: [dismiss, snooze]).choice?.confirm == snooze)
        #expect(item("x", awaits: true, actions: []).choice == nil)
    }

    @Test func upcomingDayNamesFollowTheCalendar() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Asia/Tokyo"))
        let now = try #require(HomeTimestamp.parse("2026-11-13T07:30:00Z"))
        func day(_ text: String) throws -> UpcomingDay {
            UpcomingDay.of(try #require(HomeTimestamp.parse(text)), now: now, calendar: calendar)
        }
        #expect(try day("2026-11-13T08:00:00Z") == .today)
        #expect(try day("2026-11-13T12:00:00Z") == .tonight)
        #expect(try day("2026-11-13T23:40:00Z") == .tomorrow)
        #expect(try day("2026-11-18T23:40:00Z") == .weekday(5))
        #expect(try day("2026-11-20T23:40:00Z") == .date(month: 11, day: 21))
    }

    @Test func picksTheFeedLanguageFromThePhoneLanguages() {
        #expect(HomeLocale.matching(["ja-JP", "en-US"]) == .japanese)
        #expect(HomeLocale.matching(["en-GB"]) == .english)
        #expect(HomeLocale.matching(["zh-Hans-CN"]) == .chinese)
        #expect(HomeLocale.matching(["fr-FR"]) == .chinese)
    }
}
