import UIKit
import XCTest

@MainActor
final class PerceptionDeletionTests: XCTestCase {
    private let module = "HimawariSenses"

    override func setUp() async throws {
        continueAfterFailure = false
    }

    func testSwipingAnEpisodeAsksFirstAndCancelKeepsIt() {
        let app = DemoApp.launch("next-7-delete-perception")
        let meeting = SourceText.zh(module, "demo.meeting")
        let row = episodeRow(meeting, in: app)
        let deleted = deletedNotice(in: app)
        swipeToDelete(row, in: app)
        let question = SourceText.zh(module, "delete.confirmEpisode").replacingOccurrences(of: "%@", with: meeting)
        XCTAssertTrue(app.staticTexts[question].waitForExistence(timeout: 5), "swiping to delete did not ask \(question)")
        dismissWithoutDeleting(in: app)
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !app.staticTexts[question].exists }, "cancel did not close the question")
        XCTAssertFalse(deleted.waitForExistence(timeout: 2), "cancel still deleted the episode")
        XCTAssertTrue(row.exists, "cancel removed the episode from the list")
        swipeToDelete(row, in: app)
        XCTAssertTrue(app.staticTexts[question].waitForExistence(timeout: 5), "the second swipe did not ask again")
        app.buttons[SourceText.zh(module, "detail.delete")].firstMatch.tap()
        XCTAssertTrue(deleted.waitForExistence(timeout: 10), "confirming did not report how many records were deleted")
        app.buttons[SourceText.zh(module, "detail.ok")].firstMatch.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !deleted.exists }, "the deleted notice did not go away")
    }

    func testTheSegmentsSwitchBetweenEpisodesAndDays() {
        let app = DemoApp.launch("next-7-delete-perception")
        let row = episodeRow(SourceText.zh(module, "demo.meeting"), in: app)
        app.buttons[SourceText.zh(module, "delete.segment.days")].firstMatch.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !row.exists }, "switching to days still lists the episodes")
        app.buttons[SourceText.zh(module, "delete.segment.episodes")].firstMatch.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5), "switching back to episodes did not list them again")
    }

    func testDeletingAWholeEpisodeAsksFirst() {
        let app = DemoApp.launch("next-7-delete-perception-episode")
        let whole = app.buttons[SourceText.zh(module, "delete.wholeEpisode")].firstMatch
        XCTAssertTrue(whole.waitForExistence(timeout: 10), "the episode page has no button to delete the whole episode")
        XCTAssertTrue(DemoApp.scrollUntilOnScreen(whole, in: app), "could not scroll to the delete button")
        whole.tap()
        let question = app.staticTexts[SourceText.zh(module, "delete.confirmThisEpisode")]
        XCTAssertTrue(question.waitForExistence(timeout: 5), "deleting the whole episode did not ask first")
        app.buttons[SourceText.zh(module, "detail.delete")].firstMatch.tap()
        let deleted = deletedNotice(in: app)
        XCTAssertTrue(deleted.waitForExistence(timeout: 10), "confirming did not report how many records were deleted")
        app.buttons[SourceText.zh(module, "detail.ok")].firstMatch.tap()
        XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { !deleted.exists }, "the deleted notice did not go away")
    }

    private func dismissWithoutDeleting(in app: XCUIApplication) {
        let cancel = app.buttons[SourceText.zh(module, "detail.cancel")].firstMatch
        if cancel.exists, cancel.isHittable {
            cancel.tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        }
    }

    private func episodeRow(_ title: String, in app: XCUIApplication) -> XCUIElement {
        let row = app.cells.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the list has no episode \(title)")
        return row
    }

    private func swipeToDelete(_ row: XCUIElement, in app: XCUIApplication) {
        row.swipeLeft()
        let button = row.buttons[SourceText.zh(module, "delete.swipe")].firstMatch
        let anywhere = app.buttons[SourceText.zh(module, "delete.swipe")].firstMatch
        let target = button.waitForExistence(timeout: 3) ? button : anywhere
        XCTAssertTrue(target.waitForExistence(timeout: 3), "swiping left on the episode showed no delete button")
        target.tap()
    }

    private func deletedNotice(in app: XCUIApplication) -> XCUIElement {
        let text = SourceText.zh(module, "detail.deleted").replacingOccurrences(of: "%d", with: "1")
        return app.staticTexts[text].firstMatch
    }
}
