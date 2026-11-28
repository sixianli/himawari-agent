import XCTest

@MainActor
final class BackgroundWorkTests: XCTestCase {
    private let module = "HimawariChat"

    override func setUp() async throws {
        continueAfterFailure = true
    }

    func testTheCapsuleOpensBackgroundWorkAndShowsOnlyWhenThereIsSome() {
        let none = DemoApp.launch("next-8-background-none")
        XCTAssertTrue(none.descendants(matching: .any)["chat.input"].firstMatch.waitForExistence(timeout: 10), "the chat did not open")
        XCTAssertFalse(capsule(in: none).exists, "the chat shows the background work capsule with nothing running in the background")
        none.terminate()
        let app = DemoApp.launch("next-8-background")
        let pill = capsule(in: app)
        XCTAssertTrue(pill.waitForExistence(timeout: 10), "the chat does not show the background work capsule")
        pill.tap()
        let title = app.navigationBars[SourceText.zh(module, "background.title")]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "tapping the capsule did not open background work")
        app.buttons[SourceText.zh(module, "process.sheet.close")].firstMatch.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !title.exists }, "the close button did not close background work")
        XCTAssertTrue(pill.isHittable, "the capsule is gone after closing background work")
    }

    func testEverySubthreadInBackgroundWorkOpensAPageYouCanGoBackFrom() throws {
        let app = DemoApp.launch("next-8-background-sheet")
        let page = app.scrollViews.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "background work has no scroll view")
        Thread.sleep(forTimeInterval: 1)
        try DemoApp.openEveryRow(in: page, of: app, named: "background work", atLeast: 2)
    }

    func testTheExchangesOpenAndClose() {
        let titles = SourceText.zh(module, keysStartingWith: "background.exchange.")
        XCTAssertFalse(titles.isEmpty, "no background.exchange.* strings in \(module)")
        let shown = NSPredicate(format: "label IN %@", titles)
        let closed = DemoApp.launch("next-8-background-subthread")
        let toggle = exchangesButton(in: closed)
        XCTAssertFalse(closed.staticTexts.matching(shown).firstMatch.exists, "the exchanges are open before tapping")
        toggle.tap()
        XCTAssertTrue(closed.staticTexts.matching(shown).firstMatch.waitForExistence(timeout: 5), "tapping the exchanges row did not open them")
        closed.terminate()
        let open = DemoApp.launch("next-8-background-exchanges")
        let header = exchangesButton(in: open)
        XCTAssertTrue(open.staticTexts.matching(shown).firstMatch.waitForExistence(timeout: 5), "the exchanges page did not open with the exchanges showing")
        header.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !open.staticTexts.matching(shown).firstMatch.exists }, "tapping the exchanges row did not close them")
    }

    private func capsule(in app: XCUIApplication) -> XCUIElement {
        let prefix = SourceText.zh(module, "background.capsule").components(separatedBy: "%d")[0]
        return app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func exchangesButton(in app: XCUIApplication) -> XCUIElement {
        let prefix = SourceText.zh(module, "background.exchanges.count").components(separatedBy: "%d")[0]
        let button = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 10), "the subthread page has no exchanges row")
        XCTAssertTrue(DemoApp.scrollUntilOnScreen(button, in: app), "could not scroll to the exchanges row")
        return button
    }
}
