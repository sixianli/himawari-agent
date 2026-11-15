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
        HomeFeedAction(action: "done", label: "完成", polarity: .positive),
        HomeFeedAction(action: "mute", label: "不再提醒", polarity: .negative),
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

    @Test func rejectsAnotherMessageType() {
        let data = Data(#"{"type":"thread.snapshot","payload":{}}"#.utf8)
        #expect(throws: (any Error).self) { try HomeFeedSnapshot.decode(data) }
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
        let snooze = HomeFeedAction(action: "snooze", label: "稍后再提醒", polarity: .neutral)
        let done = HomeFeedAction(action: "done", label: "完成", polarity: .positive)
        let dismiss = HomeFeedAction(action: "dismiss", label: "知道了", polarity: .negative)
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
