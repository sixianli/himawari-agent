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
        try DemoApp.openEveryRow(in: page, of: app, named: "the Himawari page", atLeast: 4)
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
}
