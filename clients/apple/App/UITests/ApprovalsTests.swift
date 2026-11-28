import XCTest

@MainActor
final class ApprovalsTests: XCTestCase {
    private let module = "HimawariManage"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testTheListSwitchesBetweenWaitingAndHandled() {
        let app = DemoApp.launch("17-today-more-1-approvals")
        let card = firstCard(in: app)
        app.buttons[SourceText.zh(module, "approval.segment.handled")].firstMatch.tap()
        let approved = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", SourceText.zh(module, "approval.status.approved"))).firstMatch
        XCTAssertTrue(approved.waitForExistence(timeout: 5), "switching to handled did not list what was already decided")
        XCTAssertFalse(card.exists, "switching to handled still lists what is waiting")
        waitingSegment(in: app).tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5), "switching back did not list what is waiting again")
    }

    func testOpeningARequestShowsWhyAndGoesBackToTheList() {
        let app = DemoApp.launch("next-3-her-approvals")
        let card = firstCard(in: app)
        card.tap()
        let why = app.staticTexts[SourceText.zh(module, "approval.why")].firstMatch
        XCTAssertTrue(why.waitForExistence(timeout: 5), "opening the request did not show why Himawari is asking")
        DemoApp.swipeBackFromTheLeftEdge(app)
        if !waitingSegment(in: app).waitForExistence(timeout: 3) {
            let back = app.navigationBars.firstMatch.buttons.firstMatch
            if back.exists, back.isHittable { back.tap() }
        }
        XCTAssertTrue(waitingSegment(in: app).waitForExistence(timeout: 5), "going back from the request did not return to the waiting list")
        XCTAssertTrue(card.exists, "the waiting list lost the request after going back")
    }

    private func firstCard(in app: XCUIApplication) -> XCUIElement {
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "用 Himawari 的闹钟")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 10), "the waiting list does not show the alarm request")
        return card
    }

    private func waitingSegment(in app: XCUIApplication) -> XCUIElement {
        let prefix = SourceText.zh(module, "approval.segment.pending").components(separatedBy: "%d")[0]
        return app.buttons.matching(NSPredicate(format: "label MATCHES %@", NSRegularExpression.escapedPattern(for: prefix) + "[0-9]+")).firstMatch
    }
}
