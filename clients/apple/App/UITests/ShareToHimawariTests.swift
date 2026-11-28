import UIKit
import XCTest

@MainActor
final class ShareToHimawariTests: XCTestCase {
    private let module = "HimawariShare"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testTheShareSwitchTurnsOffAndBackOn() {
        let app = DemoApp.launch("19-senses-share-entry")
        let title = SourceText.zh(module, "share.toggle")
        let toggle = app.switches.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "the share page has no \(title) switch")
        XCTAssertEqual(toggle.value as? String, "1", "the \(title) switch starts off although sharing is on")
        flip(toggle)
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { (toggle.value as? String) == "0" }, "tapping the \(title) switch did not turn it off")
        flip(toggle)
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { (toggle.value as? String) == "1" }, "tapping the \(title) switch again did not turn it back on")
    }

    func testTheShareSheetTakesWhatYouTypeAndLocksOnceHandedOver() {
        let send = SourceText.zh(module, "sheet.send")
        let typing = DemoApp.launch("19-senses-6-share-sheet")
        let field = typing.descendants(matching: .any)["handover.request"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "the share sheet has no request field")
        XCTAssertTrue(field.isEnabled, "the request field is greyed out before handing over")
        field.tap()
        field.typeText("，要能订座")
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { ((field.value as? String) ?? "").contains("，要能订座") }, "typing did not go into the request field, it reads \((field.value as? String) ?? "nothing")")
        XCTAssertTrue(typing.buttons[send].firstMatch.isHittable, "the \(send) button is not there while typing")
        typing.terminate()
        let answered = DemoApp.launch("19-senses-6b-share-answered")
        let done = answered.descendants(matching: .any)["handover.request"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 10), "the answered share sheet has no request field")
        XCTAssertFalse(done.isEnabled, "the request can still be edited after it was handed over")
        XCTAssertFalse(answered.buttons[send].exists, "the \(send) button is still there after handing over")
    }

    private func flip(_ toggle: XCUIElement) {
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
    }
}
