import Foundation
import Testing
@testable import HimawariCore

@Suite struct TimersTests {
    private static let snapshot = """
    {"schemaVersion":"v2","kind":"snapshot","type":"timers.snapshot","messageId":"m","payload":{"generatedAt":"2026-11-25T12:00:00.000Z","timers":[
      {"timerId":"t-rent","kind":"reminder","title":"交房租","task":"提醒我交房租","ownerWords":null,"schedule":"12 月 1 日 9:00","createdBy":"owner","status":"active","nextAt":"2026-12-01T00:00:00.000Z","lastAt":null,"runCount":0,"spentMicros":0,"runBudgetMicros":null,"lastResult":null,"createdAt":"2026-11-20T00:00:00.000Z"},
      {"timerId":"t-news","kind":"recurring","title":null,"task":"每天早上整理一下 AI 新闻，挑三条最重要的给我\\n只看英文一手来源","ownerWords":"- 每天早上给我看看 AI 新闻\\n- 只要英文的","schedule":"每天 8:00","createdBy":"agreed","status":"paused","nextAt":null,"lastAt":"2026-11-24T23:00:00Z","runCount":12,"spentMicros":60000,"runBudgetMicros":20000,"lastResult":{"text":"挑了三条","at":"2026-11-24T23:00:00Z"},"createdAt":"2026-11-12T00:00:00.000Z"},
      {"timerId":"t-gone","kind":"follow_up","title":"问田中","task":"问田中报价","ownerWords":null,"schedule":"周五","createdBy":"self","status":"cancelled","nextAt":null,"lastAt":null,"runCount":0,"spentMicros":0,"runBudgetMicros":50000,"lastResult":null,"createdAt":"2026-11-12T00:00:00.000Z"}
    ]}}
    """

    private func at(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

    private func timer(_ id: String, _ kind: OwnerTimer.Kind, _ status: OwnerTimer.Status, next: String? = nil, created: String = "2026-11-01T00:00:00Z") -> OwnerTimer {
        OwnerTimer(timerId: id, kind: kind, task: id, schedule: "s", createdBy: .owner, status: status, nextAt: next.map(at), createdAt: at(created))
    }

    @Test func decodesTheSnapshotWithNullableFields() throws {
        let snapshot = try TimersSnapshot.decode(Data(Self.snapshot.utf8))
        #expect(snapshot.timers.map(\.timerId) == ["t-rent", "t-news", "t-gone"])
        let news = snapshot.timers[1]
        #expect(news.kind == .recurring)
        #expect(news.createdBy == .agreed)
        #expect(news.status == .paused)
        #expect(news.runBudgetMicros == 20000)
        #expect(news.lastResult?.text == "挑了三条")
        #expect(snapshot.timers[0].runBudgetMicros == nil)
        #expect(snapshot.timers[0].lastResult == nil)
    }

    @Test func namesFallBackToTheFirstLineOfTheTaskCutAtTwentyCharacters() throws {
        let snapshot = try TimersSnapshot.decode(Data(Self.snapshot.utf8))
        #expect(snapshot.timers[0].name == "交房租")
        #expect(snapshot.timers[1].name == "每天早上整理一下 AI 新闻，挑三条最重…")
        let short = OwnerTimer(timerId: "x", kind: .reminder, title: "  ", task: "\n买牛奶\n别忘了", schedule: "s", createdBy: .her, createdAt: Date())
        #expect(short.name == "买牛奶")
    }

    @Test func ownerWordsDropTheListDashAndEmptyLines() throws {
        let snapshot = try TimersSnapshot.decode(Data(Self.snapshot.utf8))
        #expect(snapshot.timers[1].ownerWordLines == ["每天早上给我看看 AI 新闻", "只要英文的"])
        #expect(snapshot.timers[0].ownerWordLines.isEmpty)
    }

    @Test func groupsFollowReminderRecurringFollowUpAndSkipEmptyKinds() {
        let timers = [
            timer("f1", .followUp, .active, next: "2026-11-27T00:00:00Z"),
            timer("r1", .reminder, .active, next: "2026-11-28T00:00:00Z"),
            timer("c1", .recurring, .cancelled),
        ]
        #expect(TimerList.groups(timers).map(\.kind) == [.reminder, .followUp])
        #expect(TimerList.groups([timer("r", .reminder, .active)]).map(\.kind) == [.reminder])
        #expect(TimerList.groups([timer("x", .recurring, .finished), timer("y", .followUp, .cancelled)]).isEmpty)
    }

    @Test func activeComeFirstByNextTimeThenPausedNewestFirst() {
        let timers = [
            timer("p-old", .recurring, .paused, created: "2026-11-01T00:00:00Z"),
            timer("a-none", .recurring, .active),
            timer("a-late", .recurring, .active, next: "2026-12-02T00:00:00Z"),
            timer("p-new", .recurring, .paused, created: "2026-11-20T00:00:00Z"),
            timer("a-soon", .recurring, .active, next: "2026-11-26T00:00:00Z"),
        ]
        #expect(TimerList.groups(timers).first?.timers.map(\.timerId) == ["a-soon", "a-late", "a-none", "p-new", "p-old"])
    }

    @Test func countsOnlyActiveAndPaused() {
        let counts = TimerList.counts([timer("a", .reminder, .active), timer("b", .recurring, .paused), timer("c", .followUp, .finished), timer("d", .recurring, .active)])
        #expect(counts.active == 2)
        #expect(counts.paused == 1)
    }

    @Test func remindersCannotBePaused() {
        #expect(!timer("r", .reminder, .active).canPause)
        #expect(timer("c", .recurring, .active).canPause)
        #expect(timer("f", .followUp, .active).canPause)
    }

    @Test func whenNamesTodayTomorrowWeekdayOrDate() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "Asia/Tokyo"))
        let now = at("2026-11-25T03:00:00Z")
        #expect(TimerWhen(at("2026-11-25T10:30:00Z"), now: now, calendar: calendar) == .today(hour: 19, minute: 30))
        #expect(TimerWhen(at("2026-11-25T23:00:00Z"), now: now, calendar: calendar) == .tomorrow(hour: 8, minute: 0))
        #expect(TimerWhen(at("2026-11-28T10:00:00Z"), now: now, calendar: calendar) == .weekday(7, hour: 19, minute: 0))
        #expect(TimerWhen(at("2026-12-05T00:00:00Z"), now: now, calendar: calendar) == .day(month: 12, day: 5, hour: 9, minute: 0))
    }
}
