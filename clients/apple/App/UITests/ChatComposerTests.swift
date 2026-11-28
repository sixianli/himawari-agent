import UIKit
import XCTest

@MainActor
final class ChatComposerTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testTypingTurnsTheTalkButtonIntoSend() {
        let app = DemoApp.launch("04-chat")
        let field = input(in: app)
        let send = sendButton(in: app)
        XCTAssertFalse(send.exists, "the send button showed with nothing typed")
        field.tap()
        field.typeText("   ")
        XCTAssertFalse(send.waitForExistence(timeout: 1), "the send button showed for spaces only")
        field.typeText("几点出门")
        XCTAssertTrue(send.waitForExistence(timeout: 5), "typing did not bring up the send button")
        XCTAssertTrue(send.isHittable, "the send button is covered")
    }

    func testLongPressingTheEmptyInputOffersPaste() {
        let copied = "周五 9:30 的新干线，12:03 到"
        UIPasteboard.general.string = copied
        let app = DemoApp.launch("04-chat")
        let field = input(in: app)
        field.press(forDuration: 1.2)
        let paste = app.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", ["粘贴", "Paste"])).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "long-pressing the empty chat input did not offer Paste")
        paste.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { (field.value as? String) == copied }, "Paste did not put the copied text into the chat input")
        XCTAssertTrue(app.buttons["chat.send"].firstMatch.waitForExistence(timeout: 5), "the send button did not show after pasting")
    }

    func testJumpingToTheLatestShowsTheWholeLastMessageAboveTheInputBar() {
        let app = DemoApp.launch("motion-scroll-under-glass")
        let jump = app.buttons["chat.jumpLatest"].firstMatch
        XCTAssertTrue(jump.waitForExistence(timeout: 15), "scrolling up the long chat did not bring up the jump-to-latest button")
        Thread.sleep(forTimeInterval: 4)
        jump.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !jump.exists }, "the jump-to-latest button stayed after tapping it")
        let field = input(in: app)
        let answers = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "8:50 出门"))
        let lastBottom = answers.allElementsBoundByIndex.filter(\.exists).map(\.frame.maxY).max() ?? 0
        XCTAssertGreaterThan(lastBottom, 0, "the last answer is not on screen after jumping to the latest")
        XCTAssertLessThanOrEqual(lastBottom, field.frame.minY, "the end of the last answer is still behind the input bar after jumping to the latest")
    }

    func testDismissingTheMessageMenuLeavesTheBubbleWhereItWas() {
        let app = DemoApp.launch("04-chat")
        let answer = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "8:50 出门")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 10), "the answer is not on screen")
        let before = answer.frame
        answer.press(forDuration: 1.0)
        let copy = app.buttons[SourceText.zh("HimawariChat", "chat.menu.copy")].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5), "long-pressing the answer did not open its menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !copy.exists }, "tapping outside did not close the message menu")
        XCTAssertTrue(DemoApp.waitUntil(timeout: 3) { answer.frame == before }, "the answer did not settle back where it was after the menu closed: \(before) became \(answer.frame)")
    }

    func testTheOfflineChatSaysItIsNotConnectedAndTheOnlineChatDoesNot() {
        let notice = SourceText.zh("HimawariChat", "chat.offline")
        let offline = DemoApp.launch("16-chat-states-4-offline")
        XCTAssertTrue(shows(notice, in: offline), "the chat without a connection does not say \(notice)")
        offline.terminate()
        let online = DemoApp.launch("04-chat")
        XCTAssertFalse(shows(notice, in: online), "the connected chat says \(notice)")
    }

    private func input(in app: XCUIApplication) -> XCUIElement {
        let field = app.descendants(matching: .any)["chat.input"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the chat input is not on screen")
        return field
    }

    private func sendButton(in app: XCUIApplication) -> XCUIElement {
        app.buttons["chat.send"].firstMatch
    }

    private func shows(_ text: String, in app: XCUIApplication) -> Bool {
        let field = input(in: app)
        if field.placeholderValue == text || (field.value as? String) == text || field.label == text { return true }
        return app.descendants(matching: .any)[text].exists
    }
}
