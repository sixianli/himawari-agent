import UIKit
import XCTest

@MainActor
final class SensesPageTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testEveryRowOnTheSensesPageOpensAPageYouCanGoBackFrom() throws {
        let app = DemoApp.launch("19-senses-1-overview")
        let page = app.scrollViews.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the senses page has no scroll view")
        Thread.sleep(forTimeInterval: 1)
        try DemoApp.openEveryRow(in: page, of: app, named: "the senses page", atLeast: 4)
    }

    func testTheLocationAlwaysAllowSwitchCanBeTappedAndFollowsTheSystemAnswer() {
        let app = DemoApp.launch("19-senses-4-detail")
        let title = SourceText.zh("HimawariSenses", "detail.always")
        let toggle = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "the location page has no \(title) switch")
        XCTAssertTrue(DemoApp.scrollUntilOnScreen(toggle, in: app), "could not scroll to the \(title) switch")
        XCTAssertTrue(toggle.isEnabled, "the \(title) switch is greyed out while location is being collected")
        XCTAssertEqual(toggle.value as? String, "0", "the \(title) switch starts on although the system only allows location while using the app")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        Thread.sleep(forTimeInterval: 1)
        XCTAssertEqual(toggle.value as? String, "0", "the \(title) switch turned on although the system did not allow location all the time")
        let systemAlert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        XCTAssertFalse(systemAlert.exists, "the demo page asked the system for a permission")
    }
}
