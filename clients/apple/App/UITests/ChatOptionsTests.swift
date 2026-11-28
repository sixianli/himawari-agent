import XCTest

@MainActor
final class ChatOptionsTests: XCTestCase {
    private let module = "HimawariChat"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testPickingAnOptionLocksTheOthers() {
        let app = DemoApp.launch("next-2-chat-options")
        let labels = ["查哪家最便宜", "发售前一天提醒我", "不用了"]
        let options = labels.map { app.buttons[$0].firstMatch }
        for (label, option) in zip(labels, options) {
            XCTAssertTrue(option.waitForExistence(timeout: 10), "the answer has no option \(label)")
            XCTAssertTrue(option.isEnabled, "the option \(label) cannot be picked before anything was picked")
        }
        XCTAssertTrue(DemoApp.scrollUntilOnScreen(options[1], in: app), "could not scroll to the option \(labels[1])")
        options[1].tap()
        for (label, option) in zip(labels, options) {
            XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !option.isEnabled }, "the option \(label) can still be picked after \(labels[1]) was picked")
        }
    }

    func testAnAnsweredChoiceShowsWhatWasPickedAndCannotBePickedAgain() {
        let app = DemoApp.launch("next-2-chat-options-chosen")
        XCTAssertTrue(app.staticTexts[SourceText.zh(module, "chat.option.chosen")].firstMatch.waitForExistence(timeout: 10), "the chat does not say which option was picked")
        let other = app.buttons["先记进日历"].firstMatch
        XCTAssertTrue(other.waitForExistence(timeout: 5), "the old options are gone from the answer")
        XCTAssertFalse(other.isEnabled, "an option from an answered choice can still be picked")
    }
}
