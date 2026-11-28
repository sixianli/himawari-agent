import Foundation
import UIKit
import XCTest

@MainActor
enum DemoApp {
    static let largestText = "UICTContentSizeCategoryAccessibilityXXXL"

    static func launch(_ scene: String, textSize: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-HimawariDemoScene", scene, "-HimawariDemoAppearance", "light", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "\(scene) did not reach the foreground")
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10), "\(scene) showed no window")
        return app
    }

    static func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return condition()
    }

    static func onScreen(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        guard element.exists, element.isHittable else { return false }
        let window = app.windows.firstMatch.frame
        return element.frame.minY >= window.minY && element.frame.maxY <= window.maxY + 1
    }

    static func scrollUntilOnScreen(_ element: XCUIElement, in app: XCUIApplication, swipes: Int = 10) -> Bool {
        for _ in 0..<swipes {
            if onScreen(element, in: app) { return true }
            if element.exists, element.frame.minY < app.windows.firstMatch.frame.minY {
                app.swipeDown()
            } else {
                app.swipeUp()
            }
        }
        return onScreen(element, in: app)
    }

    static func swipeBackFromTheLeftEdge(_ app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0.05)
    }

    static func nodes(of type: XCUIElement.ElementType, in element: XCUIElement) throws -> [(label: String, frame: CGRect)] {
        var found: [(label: String, frame: CGRect)] = []
        func walk(_ node: XCUIElementSnapshot) {
            if node.elementType == type, !node.label.isEmpty { found.append((node.label, node.frame)) }
            for child in node.children { walk(child) }
        }
        walk(try element.snapshot())
        return found
    }
}

enum SourceText {
    static let appleRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    static func zh(_ module: String, _ key: String) -> String {
        let url = appleRoot.appendingPathComponent("Sources/\(module)/Resources/zh-Hans.lproj/Localizable.strings")
        guard let text = (NSDictionary(contentsOf: url) as? [String: String])?[key] else {
            XCTFail("\(key) is not in \(url.path)")
            return key
        }
        return text
    }

    static func cases(of name: String, in file: String) throws -> [String] {
        let source = try String(contentsOf: appleRoot.appendingPathComponent(file), encoding: .utf8)
        guard let start = source.range(of: "enum \(name): String") else {
            XCTFail("no enum \(name) in \(file)")
            return []
        }
        let body = source[start.upperBound...].prefix { $0 != "}" }
        let pattern = try NSRegularExpression(pattern: #"case [a-zA-Z]+ = "([^"]+)""#)
        let text = String(body)
        return pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            Range(match.range(at: 1), in: text).map { String(text[$0]) }
        }
    }
}
