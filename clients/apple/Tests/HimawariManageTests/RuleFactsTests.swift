import Foundation
import XCTest
@testable import HimawariManage

final class RuleFactsTests: XCTestCase {
    private func rule(_ extra: String) throws -> RuleSummary {
        let json = #"{"ruleId":"r1","type":"t","summary":"给没发过邮件的人发信，先问我","status":"active","enforced":true,"updatedAt":"2026-10-20T03:00:00Z",\#(extra)}"#
        return try JSONDecoder().decode(RuleSummary.self, from: Data(json.utf8))
    }

    func testFilledFieldsBecomeRowsInPrototypeOrder() throws {
        let filled = try rule(#""quote":"第一次给谁发邮件都先让我看一眼","changes":1,"lastUsed":{"at":"2026-11-12T01:02:00Z","kind":"email","decisionId":"d1"}"#)
        let now = try XCTUnwrap(Timestamp.parse("2026-11-12T05:00:00Z"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let rows = RuleFacts.rows(filled, now: now, calendar: calendar)
        XCTAssertEqual(rows.map(\.title), [M.yourWords, M.lastUsedRule, M.changedTimes(1)])
        XCTAssertEqual(rows[0].detail, M.quoted("第一次给谁发邮件都先让我看一眼"))
        XCTAssertNotNil(rows[2].detail)
    }

    func testEmptyFieldsShowNoRows() throws {
        XCTAssertEqual(RuleFacts.rows(try rule(#""quote":null,"changes":0,"lastUsed":null"#)), [])
        XCTAssertEqual(RuleFacts.rows(try rule(#""quote":"   ","changes":0,"lastUsed":null"#)), [])
    }

    func testChangedQuoteOpensTheLatestMemoryWhenItIsVisible() throws {
        let linked = try rule(#""quote":"第一次给谁发邮件都先让我看一眼","changes":1,"lastUsed":null,"quoteSuperseded":true,"quoteLatestMemoryId":"m6""#)
        let row = try XCTUnwrap(RuleFacts.rows(linked).first)
        XCTAssertEqual(row.note, M.quoteChangedLater)
        XCTAssertEqual(row.opensMemory, "m6")

        let unlinked = try rule(#""quote":"第一次给谁发邮件都先让我看一眼","changes":1,"lastUsed":null,"quoteSuperseded":true,"quoteLatestMemoryId":null"#)
        let plain = try XCTUnwrap(RuleFacts.rows(unlinked).first)
        XCTAssertEqual(plain.note, M.quoteChangedLater)
        XCTAssertNil(plain.opensMemory)
    }

    func testUnchangedQuoteHasNoNoteAndOpensNothing() throws {
        for extra in [#""quoteSuperseded":false,"quoteLatestMemoryId":"m6""#, #""quoteSuperseded":null"#, #""changes":0"#] {
            let base = extra.contains("changes") ? #""quote":"原话","lastUsed":null,"# : #""quote":"原话","changes":0,"lastUsed":null,"#
            let row = try XCTUnwrap(RuleFacts.rows(try rule(base + extra)).first)
            XCTAssertNil(row.note)
            XCTAssertNil(row.opensMemory)
        }
    }

    func testPausedOrUnreviewedRulesSayWhereTheyStand() throws {
        let paused = try JSONDecoder().decode(
            RuleSummary.self,
            from: Data(#"{"ruleId":"r1","type":"t","summary":"s","status":"active","enforced":false,"updatedAt":"2026-10-20T03:00:00Z","quote":null,"changes":0,"lastUsed":null}"#.utf8)
        )
        XCTAssertEqual(RuleFacts.rows(paused).map(\.title), [M.rulePaused])
    }
}
