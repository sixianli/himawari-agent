import Foundation
import XCTest

@MainActor
final class AccessibilityAuditTests: XCTestCase {
    private static let appleRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    private static let largestText = "UICTContentSizeCategoryAccessibilityXXXL"

    override func setUp() async throws {
        continueAfterFailure = true
    }

    func testEveryDemoSceneInLightAndDark() throws {
        var found: [AuditFinding] = []
        for scene in try Self.scenes() {
            let app = launch(scene, textSize: nil)
            for appearance in [XCUIDevice.Appearance.light, .dark] {
                XCUIDevice.shared.appearance = appearance
                found += try audit(app, scene: scene, mode: appearance == .dark ? "dark" : "light")
            }
            app.terminate()
        }
        XCUIDevice.shared.appearance = .light
        try judge(found, mode: "appearance")
    }

    func testEveryDemoSceneAtLargestText() throws {
        var found: [AuditFinding] = []
        XCUIDevice.shared.appearance = .light
        for scene in try Self.scenes() {
            let app = launch(scene, textSize: Self.largestText)
            found += try audit(
                app,
                scene: scene,
                mode: "largest-text",
                types: [.dynamicType, .textClipped, .hitRegion, .elementDetection]
            )
            app.terminate()
        }
        try judge(found, mode: "largest-text")
    }

    private func launch(_ scene: String, textSize: String?) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-HimawariDemoScene", scene, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        if let textSize {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize]
        }
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "\(scene) did not reach the foreground")
        _ = app.windows.firstMatch.waitForExistence(timeout: 10)
        Thread.sleep(forTimeInterval: 1)
        return app
    }

    private func audit(
        _ app: XCUIApplication,
        scene: String,
        mode: String,
        types: XCUIAccessibilityAuditType = .all
    ) throws -> [AuditFinding] {
        var found: [AuditFinding] = []
        try app.performAccessibilityAudit(for: types) { issue in
            found.append(AuditFinding(scene: scene, mode: mode, issue: issue))
            return true
        }
        return found
    }

    private func judge(_ found: [AuditFinding], mode: String) throws {
        let baseline = try AuditBaseline.load(from: Self.appleRoot.appendingPathComponent(AuditBaseline.path))
        let unique = Dictionary(found.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        for finding in unique.values.sorted(by: { $0.key < $1.key }) {
            let known = baseline.keys.contains(finding.key)
            print("A11Y_AUDIT_\(known ? "KNOWN" : "NEW") \(finding.key) :: \(finding.detail)")
            if !known {
                XCTFail("New accessibility issue \(finding.key): \(finding.detail)")
            }
        }
        let checkedScenes = Set(try Self.scenes())
        for key in baseline.keys.sorted() where key.mode == mode && checkedScenes.contains(key.scene) && unique[key] == nil {
            print("A11Y_AUDIT_FIXED \(key)")
            XCTFail("\(key) no longer happens; remove it from \(AuditBaseline.path)")
        }
        let report = unique.values.sorted(by: { $0.key < $1.key }).map(\.json)
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "accessibility-audit-\(mode).json"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("A11Y_AUDIT_DONE mode=\(mode) issues=\(unique.count) baseline=\(baseline.keys.filter { $0.mode == mode }.count)")
    }

    private static func scenes() throws -> [String] {
        let source = try String(
            contentsOf: appleRoot.appendingPathComponent("Sources/HimawariShell/DemoScenes.swift"),
            encoding: .utf8
        )
        let pattern = try NSRegularExpression(pattern: #"^ *case [a-zA-Z]+ = "([^"]+)"$"#, options: .anchorsMatchLines)
        let names = pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap { match in
            Range(match.range(at: 1), in: source).map { String(source[$0]) }
        }
        let still = names.filter { !$0.hasPrefix("motion-") && !$0.contains("system-prompt") }
        if let only = ProcessInfo.processInfo.environment["HIMAWARI_AUDIT_ONLY"], !only.isEmpty {
            let chosen = Set(only.split(separator: ",").map(String.init))
            return still.filter(chosen.contains)
        }
        XCTAssertFalse(still.isEmpty, "no demo scenes found in DemoScenes.swift")
        return still
    }
}

struct AuditKey: Hashable, Comparable, CustomStringConvertible, Sendable {
    let scene: String
    let mode: String
    let type: String
    let element: String

    var description: String { "\(scene)|\(mode)|\(type)|\(element)" }

    static func < (lhs: AuditKey, rhs: AuditKey) -> Bool { lhs.description < rhs.description }

    init(scene: String, mode: String, type: String, element: String) {
        self.scene = scene
        self.mode = mode
        self.type = type
        self.element = element
    }

    init?(_ text: String) {
        let parts = text.split(separator: "|", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4 else { return nil }
        self.init(scene: parts[0], mode: parts[1], type: parts[2], element: parts[3])
    }
}

@MainActor
struct AuditFinding {
    let key: AuditKey
    let detail: String

    init(scene: String, mode: String, issue: XCUIAccessibilityAuditIssue) {
        let element = issue.element.map { element -> String in
            let name = [element.identifier, element.label].first { !$0.isEmpty } ?? "(unnamed)"
            return "\(element.elementType.rawValue):\(name)"
        } ?? "(no element)"
        key = AuditKey(scene: scene, mode: mode, type: Self.name(issue.auditType), element: element)
        detail = "\(issue.compactDescription) — \(issue.detailedDescription)"
    }

    var json: [String: String] {
        ["scene": key.scene, "mode": key.mode, "type": key.type, "element": key.element, "detail": detail]
    }

    private static func name(_ type: XCUIAccessibilityAuditType) -> String {
        let names: [(XCUIAccessibilityAuditType, String)] = [
            (.contrast, "contrast"),
            (.elementDetection, "elementDetection"),
            (.hitRegion, "hitRegion"),
            (.sufficientElementDescription, "sufficientElementDescription"),
            (.dynamicType, "dynamicType"),
            (.textClipped, "textClipped"),
            (.trait, "trait"),
        ]
        return names.first { type.contains($0.0) }?.1 ?? "other-\(type.rawValue)"
    }
}

struct AuditBaseline {
    static let path = "App/UITests/accessibility-baseline.json"
    let keys: Set<AuditKey>

    static func load(from url: URL) throws -> AuditBaseline {
        let data = try Data(contentsOf: url)
        let entries = try JSONDecoder().decode([Entry].self, from: data)
        return AuditBaseline(keys: Set(entries.compactMap { AuditKey($0.key) }))
    }

    struct Entry: Decodable {
        let key: String
        let why: String
    }
}
