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
}
