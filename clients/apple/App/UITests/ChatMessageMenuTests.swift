import XCTest

@MainActor
final class ChatMessageMenuTests: XCTestCase {
    private let module = "HimawariChat"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testReplyingQuotesTheAnswerAboveTheInputAndCancelTakesItAway() {
        let app = DemoApp.launch("04-chat")
        choose("chat.menu.reply", fromTheMenuOf: "8:50 出门", in: app)
        let quote = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", SourceText.zh(module, "chat.reply.toAgent"))).firstMatch
        XCTAssertTrue(quote.waitForExistence(timeout: 5), "choosing reply did not show who you are replying to above the input")
        let cancel = app.buttons[SourceText.zh(module, "chat.reply.cancel")].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "the reply has no button to cancel it")
        cancel.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !quote.exists }, "cancelling the reply did not take the quote away")
    }

    func testCopyingAnAnswerSaysItWasCopied() {
        let app = DemoApp.launch("04-chat")
        choose("chat.menu.copy", fromTheMenuOf: "8:50 出门", in: app)
        XCTAssertTrue(app.staticTexts[SourceText.zh(module, "chat.copied")].firstMatch.waitForExistence(timeout: 5), "copying the answer did not say it was copied")
    }

    func testSelectingTextOpensAPageThatDoneCloses() {
        let app = DemoApp.launch("04-chat")
        choose("chat.menu.select", fromTheMenuOf: "8:50 出门", in: app)
        let done = app.buttons[SourceText.zh(module, "chat.select.done")].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 5), "choosing select text did not open the select text page")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "8:50 出门", "8:50 出门")).firstMatch.exists, "the select text page does not show the answer")
        done.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !done.exists }, "done did not close the select text page")
    }

    private func choose(_ key: String, fromTheMenuOf text: String, in app: XCUIApplication) {
        let answer = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 10), "the answer \(text) is not on screen")
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { answer.isHittable }, "the answer \(text) cannot be touched")
        answer.press(forDuration: 1.5)
        let item = app.buttons[SourceText.zh(module, key)].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5), "long-pressing the answer did not offer \(SourceText.zh(module, key))")
        item.tap()
    }
}
