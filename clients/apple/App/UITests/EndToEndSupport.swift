import Foundation
import XCTest

struct EndToEndBackend: Sendable {
    let control: URL

    static func fromEnvironment() throws -> EndToEndBackend {
        let environment = ProcessInfo.processInfo.environment
        guard let raw = environment["HIMAWARI_E2E_CONTROL"], let control = URL(string: raw) else {
            throw XCTSkip("HIMAWARI_E2E_CONTROL is not set; run clients/apple/scripts/e2e.sh to start the end-to-end backend")
        }
        return EndToEndBackend(control: control)
    }

    struct Answers: Decodable, Sendable {
        let opening: String
        let ending: String
        let longRequest: String
    }

    struct StoredMessage: Decodable, Sendable {
        let role: String
        let text: String
    }

    func pairingLink() async throws -> URL {
        struct Link: Decodable { let link: String }
        let link: Link = try await call("POST", "pairing-link")
        guard let url = URL(string: link.link) else { throw URLError(.badURL) }
        return url
    }

    func answers() async throws -> Answers {
        try await call("GET", "answers")
    }

    func messages() async throws -> [StoredMessage] {
        struct Listed: Decodable { let messages: [StoredMessage] }
        let listed: Listed = try await call("GET", "messages")
        return listed.messages
    }

    func goOffline() async throws {
        struct State: Decodable { let online: Bool }
        let _: State = try await call("POST", "offline")
    }

    func goOnline() async throws {
        struct State: Decodable { let online: Bool }
        let _: State = try await call("POST", "online")
    }

    private func call<T: Decodable>(_ method: String, _ path: String) async throws -> T {
        var request = URLRequest(url: control.appendingPathComponent(path))
        request.httpMethod = method
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

enum AppStrings {
    private static let appleRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()

    static let language = "zh-Hans"

    private static let table: [String: String] = {
        let sources = appleRoot.appendingPathComponent("Sources")
        var merged: [String: String] = [:]
        let modules = (try? FileManager.default.contentsOfDirectory(atPath: sources.path)) ?? []
        for module in modules.sorted() {
            let file = sources
                .appendingPathComponent(module)
                .appendingPathComponent("Resources/\(language).lproj/Localizable.strings")
            guard let strings = NSDictionary(contentsOf: file) as? [String: String] else { continue }
            merged.merge(strings) { first, _ in first }
        }
        return merged
    }()

    private static let manageTable: [String: String] = {
        let file = appleRoot.appendingPathComponent("Sources/HimawariManage/ManageStrings.swift")
        guard let source = try? String(contentsOf: file, encoding: .utf8),
              let pattern = try? NSRegularExpression(pattern: #"static var ([A-Za-z]+): String \{ text\("([^"]+)""#)
        else { return [:] }
        var found: [String: String] = [:]
        for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let name = Range(match.range(at: 1), in: source), let value = Range(match.range(at: 2), in: source) else { continue }
            found[String(source[name])] = String(source[value])
        }
        return found
    }()

    static func manage(_ name: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        guard let value = manageTable[name] else {
            XCTFail("no \(language) string named \(name) in Sources/HimawariManage/ManageStrings.swift", file: file, line: line)
            return name
        }
        return value
    }

    static func text(_ key: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        guard let value = table[key] else {
            XCTFail("no \(language) string for \(key) under Sources/*/Resources", file: file, line: line)
            return key
        }
        return value
    }
}

extension XCUIApplication {
    static func himawari() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-AppleLanguages", "(\(AppStrings.language))", "-AppleLocale", "zh_CN"]
        return app
    }

    var composer: XCUIElement {
        let placeholders = [AppStrings.text("chat.input.placeholder"), AppStrings.text("chat.offline")]
        let predicate = NSPredicate(format: "placeholderValue IN %@", placeholders)
        return descendants(matching: .any).matching(predicate).firstMatch
    }

    var sendButton: XCUIElement {
        let label = AppStrings.text("chat.send")
        let keyboard = keyboards.firstMatch
        let keyboardFrame = keyboard.exists ? keyboard.frame : .null
        let matches = buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
        return matches.first { !keyboardFrame.intersects($0.frame) } ?? buttons[label].firstMatch
    }

    var herPageList: XCUIElement {
        scrollViews.containing(NSPredicate(format: "label BEGINSWITH %@", AppStrings.manage("herMemory"))).firstMatch
    }

    func texts(containing text: String) -> XCUIElementQuery {
        descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text))
    }

    func waitFor(_ timeout: TimeInterval, poll: TimeInterval = 0.2, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(poll))
        }
        return condition()
    }
}

extension XCTestCase {
    func attachScreenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
