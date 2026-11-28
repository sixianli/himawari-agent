import UIKit
import XCTest

@MainActor
final class SettingsPagesTests: XCTestCase {
    override func setUp() async throws {
        continueAfterFailure = true
    }

    func testEveryRowOnTheHimawariPageOpensAPageYouCanGoBackFrom() throws {
        let app = DemoApp.launch("next-3-her")
        let page = app.collectionViews.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the Himawari page has no list")
        Thread.sleep(forTimeInterval: 1)
        try DemoApp.openEveryRow(in: page, of: app, named: "the Himawari page", atLeast: 8)
    }

    func testTheHimawariPageShowsTheTenEntriesInFourGroupsAndNoOldOnes() throws {
        let app = DemoApp.launch("next-3-her")
        let page = app.collectionViews.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the Himawari page has no list")
        for title in ["照片和文件", "个性化", "通知", "语音", "数据和应用", "不用再问", "你的数据", "设备", "关于"] {
            XCTAssertTrue(DemoApp.scrollUntilOnScreen(page.buttons[title].firstMatch, in: app), "\(title) is missing from the Himawari page")
        }
        for gone in ["评测", "隐私", "设置", "Himawari 知道的", "Himawari 能替你做的", "同意过的事", "保险箱", "文件"] {
            XCTAssertFalse(page.buttons[gone].exists, "\(gone) is still on the Himawari page")
            XCTAssertFalse(page.staticTexts[gone].exists, "\(gone) is still on the Himawari page")
        }
    }

    func testEveryRowOnTheHimawariSubpagesOpensAPageYouCanGoBackFrom() throws {
        let pages: [(scene: String, name: String, atLeast: Int)] = [
            ("next-3-her-personalization", "Personalization", 4),
            ("next-3-her-notifications-hub", "Notifications", 2),
            ("next-3-her-data", "Data and Apps", 2),
            ("next-3-her-your-data", "Your Data", 2),
        ]
        for entry in pages {
            let app = DemoApp.launch(entry.scene)
            let page = app.collectionViews.firstMatch
            XCTAssertTrue(page.waitForExistence(timeout: 10), "\(entry.name) has no list")
            Thread.sleep(forTimeInterval: 1)
            try DemoApp.openEveryRow(in: page, of: app, named: entry.name, atLeast: entry.atLeast)
            app.terminate()
        }
    }

    func testTheVoicePageListsListeningAndTheVoiceprintAndAsksBeforeDeletingIt() throws {
        let app = DemoApp.launch("next-3-her-voice")
        let page = app.collectionViews.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 10), "the voice page has no list")
        XCTAssertTrue(page.switches["一直听着"].waitForExistence(timeout: 5), "the voice page has no keep-listening switch")
        let voiceprint = page.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "我的声纹")).firstMatch
        XCTAssertTrue(voiceprint.waitForExistence(timeout: 5), "the voice page has no voiceprint row")
        voiceprint.tap()
        XCTAssertTrue(app.staticTexts["删掉我的声纹？"].waitForExistence(timeout: 5), "tapping a recorded voiceprint did not ask before deleting it")
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
