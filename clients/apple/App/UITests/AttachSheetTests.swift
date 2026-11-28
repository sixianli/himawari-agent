import XCTest

@MainActor
final class AttachSheetTests: XCTestCase {
    private let module = "HimawariChat"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testTheAttachSheetOffersEachWayAndClosesAndOpensAgain() {
        let app = DemoApp.launch("next-2-chat-attach")
        let title = app.navigationBars[SourceText.zh(module, "attach.title")]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "the attach sheet did not open")
        for key in ["attach.files", "attach.location"] {
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", SourceText.zh(module, key))).firstMatch.exists, "the attach sheet does not offer \(SourceText.zh(module, key))")
        }
        title.buttons[SourceText.zh(module, "common.close")].firstMatch.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !title.exists }, "the close button did not close the attach sheet")
        let add = app.buttons[SourceText.zh(module, "attach.add")].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5), "the chat has no \(SourceText.zh(module, "attach.add")) button")
        add.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5), "tapping \(SourceText.zh(module, "attach.add")) did not open the attach sheet again")
    }
}
