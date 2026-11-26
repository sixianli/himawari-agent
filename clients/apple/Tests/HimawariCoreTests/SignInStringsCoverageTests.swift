import Foundation
import Testing

@Suite struct SignInStringsCoverageTests {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    private func keys(in view: String) throws -> Set<String> {
        let pattern = try NSRegularExpression(pattern: #"L\.(?:text|format)\("(signIn\.[A-Za-z.]+)""#)
        let range = NSRange(view.startIndex..., in: view)
        var found = Set(pattern.matches(in: view, range: range).compactMap { match in
            Range(match.range(at: 1), in: view).map { String(view[$0]) }
        })
        for problem in ["keysUnreadable", "storage"] {
            found.insert("signIn.problem.\(problem)")
            found.insert("signIn.problem.\(problem).title")
        }
        return found
    }

    @Test func everySignInTextIsTranslatedInEveryLanguage() throws {
        let used = try keys(in: try source("Sources/HimawariShell/SignInView.swift"))
        #expect(used.count >= 30)
        for language in ["en", "ja", "zh-Hans"] {
            let strings = try source("Sources/HimawariShell/Resources/\(language).lproj/Localizable.strings")
            for key in used.sorted() {
                #expect(strings.contains("\"\(key)\" ="), "\(language) is missing \(key)")
            }
        }
    }

    @Test func theStartOverWarningReadsTheUnsentCountWhenTheDialogOpens() throws {
        let view = try source("Sources/HimawariShell/SignInView.swift")
        #expect(view.contains("Text(Self.startOverWarning(unsent: model.unsentMessages))"))
    }
}
