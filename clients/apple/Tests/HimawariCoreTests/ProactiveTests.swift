import Foundation
import HimawariCore
import Testing

struct ProactiveTests {
    private func decision(_ verdict: String, reason: String = "OK", fetched: Int = 0, skipped: Int = 0, floorRaised: Int = 0, pushed: Int = 0, judged: Int = 0) throws -> ProactiveDecision {
        let json = #"{"id":"d1","checkedAt":"2026-11-14T01:00:00.000Z","verdict":"\#(verdict)","reasonCode":"\#(reason)","counts":{"fetched":\#(fetched),"skipped":\#(skipped),"judged":\#(judged),"act":0,"know":0,"check":0,"ignore":0,"floorRaised":\#(floorRaised),"pushed":\#(pushed)},"opened":false,"rating":null}"#
        return try JSONDecoder().decode(ProactiveDecision.self, from: Data(json.utf8))
    }

    @Test func pushedAndDeferredCanBeRatedUsefulOrUnneeded() throws {
        #expect(try decision("pushed").rateChoices == [.useful, .unneeded])
        #expect(try decision("deferred").rateChoices == [.useful, .unneeded])
    }

    @Test func silentCanOnlyBeRatedMissed() throws {
        #expect(try decision("silent").rateChoices == [.missed])
    }

    @Test func failedCappedAndNeedsOwnerCannotBeRated() throws {
        for verdict in ["failed", "capped", "capped_daily", "needs_owner"] {
            #expect(try decision(verdict).rateChoices.isEmpty)
        }
    }

    @Test func pushedLineNeverShowsZero() throws {
        #expect(try decision("pushed", pushed: 0).line == .pushed(1))
        #expect(try decision("pushed", pushed: 3).line == .pushed(3))
    }

    @Test func failureLineFollowsTheReasonCode() throws {
        #expect(try decision("failed", reason: "MODEL_OUTPUT_INVALID").line == .modelMalformed)
        #expect(try decision("failed", reason: "MODEL_OUTPUT_TRUNCATED").line == .modelCutOff)
        #expect(try decision("failed", reason: "MODEL_NOT_COMPLETED").line == .modelUnfinished)
        #expect(try decision("failed", reason: "MODEL_FAILED_TIMEOUT").line == .modelNoAnswer)
        #expect(try decision("failed", reason: "GMAIL_READ").line == .readFailed)
    }

    @Test func silentLineDependsOnWhatWasFetched() throws {
        #expect(try decision("silent").line == .noMail)
        #expect(try decision("silent", fetched: 4, skipped: 4).line == .allSkipped(4))
        #expect(try decision("silent", fetched: 4, skipped: 1, floorRaised: 2).line == .floorRaised(fetched: 4, raised: 2))
        #expect(try decision("silent", fetched: 4, skipped: 1).line == .quiet(fetched: 4, skipped: 1))
    }

    @Test func judgedBreakdownIsHiddenWhenNothingWasJudged() throws {
        #expect(try decision("silent", judged: 0).showsJudgedBreakdown == false)
        #expect(try decision("silent", judged: 2).showsJudgedBreakdown == true)
        #expect(try decision("needs_owner", judged: 2).showsJudgedBreakdown == false)
    }

    private func overview(insights: String, decisions: String = "[]") throws -> ProactiveOverview {
        let json = #"{"source":"gmail","connection":{"status":"connected","account":"a@example.com","connectedAt":null},"enabled":true,"quietHours":[{"days":[0,1,6],"start":"23:00","end":"07:00"}],"importantSenders":[],"dailyLimitReached":false,"backoff":[],"insights":\#(insights),"audit":{"active":false,"since":"2026-11-01T00:00:00.000Z","items":[],"pending":0},"decisions":\#(decisions),"generatedAt":"2026-11-14T00:00:00.000Z"}"#
        return try JSONDecoder().decode(ProactiveOverview.self, from: Data(json.utf8))
    }

    private func insight(_ id: String, status: String = "open", due: String?, updated: String = "2026-11-10T00:00:00.000Z") -> String {
        #"{"id":"\#(id)","result":"act","floorRaised":false,"summary":"s\#(id)","reason":"r","basis":"model","from":"x","subject":"y","link":"","dueAt":\#(due.map { "\"\($0)\"" } ?? "null"),"priority":null,"status":"\#(status)","pushed":false,"pushReaction":null,"rating":null,"updatedAt":"\#(updated)"}"#
    }

    @Test func openInsightsAreSortedByDueDateWithUndatedLast() throws {
        let list = "[" + [
            insight("none", due: nil),
            insight("late", due: "2026-11-20T00:00:00.000Z"),
            insight("soon", due: "2026-11-15T00:00:00.000Z"),
            insight("done", status: "done", due: "2026-11-01T00:00:00.000Z"),
        ].joined(separator: ",") + "]"
        let shown = try overview(insights: list).openInsights(limit: 10)
        #expect(shown.map(\.id) == ["soon", "late", "none"])
    }

    @Test func openInsightsRespectTheLimit() throws {
        let list = "[" + (1...5).map { insight("i\($0)", due: nil) }.joined(separator: ",") + "]"
        #expect(try overview(insights: list).openInsights(limit: 2).count == 2)
    }

    @Test func recentDecisionsComeNewestFirst() throws {
        let old = #"{"id":"old","checkedAt":"2026-11-13T01:00:00.000Z","verdict":"silent","reasonCode":"OK","counts":{"fetched":0,"skipped":0,"judged":0,"act":0,"know":0,"check":0,"ignore":0,"floorRaised":0,"pushed":0},"opened":false,"rating":null}"#
        let new = old.replacingOccurrences(of: "old", with: "new").replacingOccurrences(of: "2026-11-13", with: "2026-11-14")
        let shown = try overview(insights: "[]", decisions: "[\(old),\(new)]").recentDecisions(limit: 5)
        #expect(shown.map(\.id) == ["new", "old"])
    }

    @Test func quietHoursListMondayFirst() throws {
        let period = try #require(try overview(insights: "[]").quietHours.first)
        #expect(period.sortedDays == [1, 6, 0])
        #expect(period.coversEveryDay == false)
    }

    private func source(limit: Int = 50, minimum: Int = 5, maximum: Int = 200) throws -> ProactiveSource {
        let json = #"{"source":"gmail","intake":"reader","trust":"external","enabled":true,"perDay":{"limit":\#(limit),"defaultLimit":50,"minimum":\#(minimum),"maximum":\#(maximum),"used":12,"resetsAt":"2026-11-15T00:00:00.000Z","onReach":"hold_until_reset"},"perCheck":{"limit":10,"defaultLimit":10,"minimum":1,"maximum":50,"onReach":"hold_until_next_check"},"dailyLimitReached":false,"updatedAt":null}"#
        return try JSONDecoder().decode(ProactiveSource.self, from: Data(json.utf8))
    }

    @Test func limitStepsStayInsideTheServersBounds() throws {
        let perDay = try source().perDay
        #expect(perDay.stepUp(from: 200) == 200)
        #expect(perDay.stepDown(from: 5) == 5)
        #expect(perDay.stepUp(from: 50) > 50)
        #expect(perDay.stepDown(from: 50) < 50)
        #expect(perDay.clamped(1000) == 200)
    }

    @Test func limitStepsDoNotOverflowOnHugeBounds() throws {
        let json = #"{"limit":1,"defaultLimit":1,"minimum":1,"maximum":9223372036854775807,"used":null,"resetsAt":null}"#
        let spec = try JSONDecoder().decode(ProactiveDayLimit.self, from: Data(json.utf8))
        #expect(spec.stepUp(from: Int.max) == Int.max)
        #expect(spec.stepDown(from: 1) == 1)
        #expect(spec.step <= 1_000_000_000)
    }

    @Test func sourceNameIsShownReadably() throws {
        #expect(try source().displayName == "Gmail")
    }

    @Test func perCheckCarriesNoUsageNumber() throws {
        let item = try source()
        #expect(item.perDay.used == 12)
        #expect(item.perCheck.used == nil)
    }

    @Test func unknownRatingStringsAreIgnoredNotFatal() throws {
        let json = #"{"id":"i","result":"act","summary":"s","reason":"r","from":"x","dueAt":null,"priority":null,"status":"open","pushed":false,"pushReaction":null,"rating":"strange","updatedAt":"2026-11-10T00:00:00.000Z"}"#
        let item = try JSONDecoder().decode(ProactiveInsight.self, from: Data(json.utf8))
        #expect(item.ownerRating == nil)
    }
}
