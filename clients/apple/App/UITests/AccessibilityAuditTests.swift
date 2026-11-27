import Foundation
import UIKit
import XCTest

@MainActor
final class AccessibilityAuditTests: XCTestCase {
    private static let appleRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    override func setUp() async throws {
        continueAfterFailure = true
    }

    func testEveryDemoScene() throws {
        var found: [AuditFinding] = []
        let modes: [(name: String, appearance: XCUIDevice.Appearance, types: XCUIAccessibilityAuditType)] = [
            ("light", .light, .all),
            ("dark", .dark, .contrast),
        ]
        for scene in try Self.scenes() {
            var brightness: [String: Double] = [:]
            for mode in modes {
                XCUIDevice.shared.appearance = mode.appearance
                let app = launch(scene, appearance: mode.name)
                brightness[mode.name] = Self.brightness(of: app)
                found += audit(app, scene: scene, mode: mode.name, types: mode.types)
                app.terminate()
            }
            let light = brightness["light"] ?? .nan
            let dark = brightness["dark"] ?? .nan
            print("A11Y_APPEARANCE \(scene) light=\(light) dark=\(dark)")
            guard light >= Self.midLuminance else { continue }
            XCTAssertLessThan(
                dark,
                light,
                "I-121 \(scene): the dark run was not darker than the light run, so the dark contrast audit did not actually look at the dark appearance"
            )
        }
        XCUIDevice.shared.appearance = .light
        try judge(found)
    }

    private func launch(_ scene: String, appearance: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-HimawariDemoScene", scene, "-HimawariDemoAppearance", appearance, "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "\(scene) did not reach the foreground")
        _ = app.windows.firstMatch.waitForExistence(timeout: 10)
        Thread.sleep(forTimeInterval: 1)
        let systemAlert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        XCTAssertFalse(systemAlert.exists, "\(scene) asked the system for a permission; demo scenes must not, or the alert stays up and blocks every later scene")
        return app
    }

    private func audit(
        _ app: XCUIApplication,
        scene: String,
        mode: String,
        types: XCUIAccessibilityAuditType
    ) -> [AuditFinding] {
        var lastFailure: Error?
        for _ in 0..<Self.auditAttempts {
            var found: [AuditFinding] = []
            do {
                try app.performAccessibilityAudit(for: types) { issue in
                    found.append(AuditFinding(scene: scene, mode: mode, issue: issue))
                    return true
                }
                return found
            } catch {
                lastFailure = error
            }
        }
        return lastFailure.map { [AuditFinding(scene: scene, mode: mode, failure: $0)] } ?? []
    }

    private static let auditAttempts = 2
    private static let midLuminance = 0.5

    private static func brightness(of app: XCUIApplication) -> Double {
        guard let image = app.windows.firstMatch.screenshot().image.cgImage else { return .nan }
        let side = 32
        var pixels = [UInt8](repeating: 0, count: side * side * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: side,
                height: side,
                bitsPerComponent: 8,
                bytesPerRow: side * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
            return true
        }
        guard drawn else { return .nan }
        var total = 0.0
        for index in stride(from: 0, to: pixels.count, by: 4) {
            total += 0.2126 * Double(pixels[index]) + 0.7152 * Double(pixels[index + 1]) + 0.0722 * Double(pixels[index + 2])
        }
        return total / Double(side * side) / 255
    }

    private func judge(_ found: [AuditFinding]) throws {
        let baseline = try AuditBaseline.load(from: Self.appleRoot.appendingPathComponent(AuditBaseline.path))
        let checkedScenes = Set(try Self.scenes())
        let counts = Dictionary(grouping: found, by: \.key).mapValues(\.count)
        for finding in found.sorted(by: { ($0.key, $0.element) < ($1.key, $1.element) }) {
            print("A11Y_AUDIT_ISSUE \(finding.key)|\(finding.element) :: \(finding.detail)")
        }
        for key in Set(counts.keys).union(baseline.counts.keys).sorted() where checkedScenes.contains(key.scene) {
            let now = counts[key] ?? 0
            let allowed = baseline.counts[key] ?? 0
            print("A11Y_AUDIT_COUNT \(key) \(now)")
            if now > allowed {
                XCTFail("\(key): \(now) accessibility issues, \(AuditBaseline.path) allows \(allowed); fix the new ones (see A11Y_AUDIT_ISSUE lines)")
            } else if now < allowed {
                print("::warning::A11Y_AUDIT_STALE \(key): only \(now) accessibility issues left, lower its count in \(AuditBaseline.path) to \(now)")
            }
        }
        let report = found.map(\.json)
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "accessibility-audit.json"
        attachment.lifetime = .keepAlways
        add(attachment)
        print("A11Y_AUDIT_DONE scenes=\(checkedScenes.count) issues=\(found.count)")
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
        XCTAssertFalse(still.isEmpty, "no demo scenes found in DemoScenes.swift")
        let environment = ProcessInfo.processInfo.environment
        if let only = environment["HIMAWARI_AUDIT_ONLY"], !only.isEmpty {
            let chosen = Set(only.split(separator: ",").map(String.init))
            return still.filter(chosen.contains)
        }
        if let shard = environment["HIMAWARI_AUDIT_SHARD"], !shard.isEmpty {
            let parts = shard.split(separator: "/").compactMap { Int($0) }
            guard parts.count == 2, parts[1] > 0, (0..<parts[1]).contains(parts[0]) else {
                XCTFail("HIMAWARI_AUDIT_SHARD must look like 0/3, got \(shard)")
                return []
            }
            return still.enumerated().filter { $0.offset % parts[1] == parts[0] }.map(\.element)
        }
        return still
    }
}

struct AuditKey: Hashable, Comparable, CustomStringConvertible, Sendable {
    let scene: String
    let mode: String
    let type: String

    var description: String { "\(scene)|\(mode)|\(type)" }

    static func < (lhs: AuditKey, rhs: AuditKey) -> Bool { lhs.description < rhs.description }

    init(scene: String, mode: String, type: String) {
        self.scene = scene
        self.mode = mode
        self.type = type
    }

    init?(_ text: String) {
        let parts = text.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3 else { return nil }
        self.init(scene: parts[0], mode: parts[1], type: parts[2])
    }
}

@MainActor
struct AuditFinding {
    let key: AuditKey
    let element: String
    let detail: String

    init(scene: String, mode: String, issue: XCUIAccessibilityAuditIssue) {
        element = issue.element.map { element -> String in
            let name = [element.identifier, element.label].first { !$0.isEmpty } ?? "(unnamed)"
            return "\(element.elementType.rawValue):\(name)"
        } ?? "(no element)"
        key = AuditKey(scene: scene, mode: mode, type: Self.name(issue.auditType))
        detail = "\(issue.compactDescription) — \(issue.detailedDescription)"
    }

    init(scene: String, mode: String, failure: Error) {
        key = AuditKey(scene: scene, mode: mode, type: "auditDidNotFinish")
        element = "(no element)"
        detail = failure.localizedDescription
    }

    var json: [String: String] {
        ["scene": key.scene, "mode": key.mode, "type": key.type, "element": element, "detail": detail]
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
    let counts: [AuditKey: Int]

    static func load(from url: URL) throws -> AuditBaseline {
        let entries = try JSONDecoder().decode([Entry].self, from: Data(contentsOf: url))
        var counts: [AuditKey: Int] = [:]
        for entry in entries {
            guard let key = AuditKey(entry.key), !entry.why.isEmpty else {
                XCTFail("\(path): \(entry.key) needs scene|mode|type and a reason")
                continue
            }
            counts[key] = entry.count
        }
        return AuditBaseline(counts: counts)
    }

    struct Entry: Decodable {
        let key: String
        let count: Int
        let why: String
    }
}
