import Foundation
import Testing

@Suite struct WatchPairingKeyOrderTests {
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
    }

    @Test func watchPairingReadsBothPublicKeysBeforeTheServerCanPairTheDevice() throws {
        let model = try source("Sources/HimawariWatchUI/WatchModel.swift")
        let submit = try #require(model.range(of: "private func submit(_ text: String)"))
        let body = model[submit.upperBound...]
        let pair = try #require(body.range(of: "try await api.pair("))
        for read in ["let devicePublicKey = try deviceKey.publicKeySPKI()", "let confirmPublicKey = try confirmKey.publicKeySPKI()"] {
            let found = try #require(body.range(of: read), "WatchModel does not read \(read)")
            #expect(found.lowerBound < pair.lowerBound, "WatchModel reads a key after the server may have paired")
        }
    }
}
