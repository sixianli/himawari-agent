import UIKit
import XCTest

@MainActor
final class SettingsPagesTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = true
    }

    func testEveryRowOnTheHimawariPageOpensAPageYouCanGoBackFrom() throws {
        let app = DemoApp.launch("next-3-her")
        let page = app.scrollViews.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the Himawari page has no scroll view")
        Thread.sleep(forTimeInterval: 1)
        let rows = try rowLabels(in: page, app: app)
        XCTAssertGreaterThanOrEqual(rows.count, 4, "found only these rows on the Himawari page: \(rows)")
        for label in rows {
            let row = page.buttons[label].firstMatch
            guard DemoApp.scrollUntilOnScreen(row, in: app) else {
                XCTFail("\(label): could not scroll to the row")
                continue
            }
            row.tap()
            guard DemoApp.waitUntil(timeout: 5, { !row.isHittable }) else {
                XCTFail("\(label): tapping the row opened nothing")
                continue
            }
            var way = "edge swipe"
            DemoApp.swipeBackFromTheLeftEdge(app)
            if !DemoApp.waitUntil(timeout: 3, { row.isHittable }) {
                let back = app.navigationBars.firstMatch.buttons.firstMatch
                if back.exists, back.isHittable {
                    way = "back button \(back.label)"
                    back.tap()
                }
            }
            if !DemoApp.waitUntil(timeout: 3, { row.isHittable }) {
                way = "swipe down"
                app.swipeDown(velocity: .fast)
            }
            XCTAssertTrue(DemoApp.waitUntil(timeout: 5) { row.isHittable }, "\(label): a swipe from the left edge, the back button and a swipe down all failed to go back to the Himawari page")
            print("UI_ROW_OPENED \(label) back=\(way)")
        }
    }

    func testEverySettingsPageScrollsToItsLastLineAtTheLargestTextSize() throws {
        let scenes = try SourceText.cases(of: "ManageDemoScreen", in: "Sources/HimawariManage/ManageDemo.swift")
        XCTAssertGreaterThan(scenes.count, 10, "found only \(scenes.count) settings pages in ManageDemo.swift")
        for scene in scenes {
            let app = DemoApp.launch(scene, textSize: DemoApp.largestText)
            Thread.sleep(forTimeInterval: 1)
            let window = app.windows.firstMatch.frame
            let texts = try DemoApp.nodes(of: .staticText, in: app)
            let counts = Dictionary(grouping: texts, by: { $0.label }).mapValues(\.count)
            let below = texts.filter { counts[$0.label] == 1 && $0.frame.maxY > window.maxY + 1 }
            guard let last = below.max(by: { $0.frame.maxY < $1.frame.maxY }) else {
                print("UI_SCROLL_FITS \(scene)")
                app.terminate()
                continue
            }
            let target = app.staticTexts[last.label].firstMatch
            XCTAssertTrue(
                DemoApp.scrollUntilOnScreen(target, in: app, swipes: 12),
                "\(scene): \"\(last.label)\" sits below the screen and swiping up never brought it into view"
            )
            print("UI_SCROLL_REACHED \(scene)")
            app.terminate()
        }
    }

    private func rowLabels(in page: XCUIElement, app: XCUIApplication) throws -> [String] {
        var labels: [String] = []
        for _ in 0..<6 {
            for node in try DemoApp.nodes(of: .button, in: page) where !labels.contains(node.label) {
                labels.append(node.label)
            }
            app.swipeUp()
        }
        for _ in 0..<6 { app.swipeDown() }
        return labels
    }
}
