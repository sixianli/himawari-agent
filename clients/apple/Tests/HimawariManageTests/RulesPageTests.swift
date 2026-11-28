import Foundation
import XCTest
@testable import HimawariManage

final class RulesPageTests: XCTestCase {
    private let book = #"{"rules":[{"ruleId":"rule-quiet","type":"quiet_hours","summary":"晚上 11 点到早上 7 点别推","status":"active","enforced":true,"updatedAt":"2026-10-20T03:00:00Z"},{"ruleId":"r2","type":"spend_limit","summary":"花钱超过 5000 日元先问我","status":"active","enforced":true,"updatedAt":"2026-10-28T03:00:00Z"}]}"#
    private let quiet = #"{"version":"v1","editable":true,"enabled":true,"start":"23:00","end":"07:00","classes":[],"rules":[{"ruleId":"rule-quiet","summary":"晚上 11 点到早上 7 点别推"}]}"#

    func testARuleTheQuietHoursPageShowsIsLeftOffTheRulesPage() throws {
        let rules = try JSONDecoder().decode(RuleBook.self, from: Data(book.utf8)).rules
        let hours = try JSONDecoder().decode(QuietHours.self, from: Data(quiet.utf8))
        XCTAssertEqual(RulesPage.ownPageRules(rules, quietHours: hours).map(\.ruleId), ["r2"])
    }

    func testWithoutQuietHoursEveryRuleStaysOnTheRulesPage() throws {
        let rules = try JSONDecoder().decode(RuleBook.self, from: Data(book.utf8)).rules
        XCTAssertEqual(RulesPage.ownPageRules(rules, quietHours: nil).map(\.ruleId), ["rule-quiet", "r2"])
    }
}
