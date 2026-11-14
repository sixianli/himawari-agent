import Foundation
import Testing

@Suite struct PairingProblemCoverageTests {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    @Test func everyPairingProblemHasAKeyInThePairingView() throws {
        let record = try source("Sources/HimawariCore/PairingRecord.swift")
        let start = try #require(record.range(of: "public enum PairingProblem"))
        let body = record[start.upperBound...]
        let end = try #require(body.range(of: "\n    public static func from"))
        let cases = body[..<end.lowerBound].split(separator: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("case ") else { return nil }
            return String(trimmed.dropFirst(5).prefix { $0.isLetter || $0.isNumber })
        }
        #expect(cases.count >= 10)

        let view = try source("Sources/HimawariShell/PairingView.swift")
        let keyStart = try #require(view.range(of: "static func key(_ problem: PairingProblem)"))
        let keyBody = view[keyStart.upperBound...].prefix(1200)
        for name in cases {
            #expect(keyBody.contains("case .\(name)"), "PairingView.key has no case for .\(name)")
        }
    }

    @Test func theUnknownStatePageIsRoutedAndTranslated() throws {
        let view = try source("Sources/HimawariShell/PairingView.swift")
        let route = try #require(view.range(of: "case let .unpaired(problem?) where problem == .keysUnreadable"))
        let routeLine = view[route.lowerBound...].prefix { $0 != "\n" }
        #expect(routeLine.contains("problem == .stateUnknown"), "stateUnknown is not routed to the retry page")

        for language in ["en", "ja", "zh-Hans"] {
            let strings = try source("Sources/HimawariShell/Resources/\(language).lproj/Localizable.strings")
            for key in ["pairing.problem.stateUnknown", "pairing.problem.stateUnknown.title", "pairing.startOver.confirm", "pairing.startOver.confirmUnsent", "pairing.startOver.confirmUnknown"] {
                #expect(strings.contains("\"\(key)\" ="), "\(language) is missing \(key)")
            }
        }
    }
}
