import Foundation
import XCTest
@testable import HimawariManage

final class MemoryBasisTests: XCTestCase {
    private func item(inference: Bool = false, importBatchId: String? = nil, quotes: [String?] = []) throws -> MemoryItem {
        func json(_ value: String?) -> String {
            guard let value else { return "null" }
            return String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
        }
        let history = quotes.enumerated().map { index, quote in
            #"{"historyId":\#(index + 1),"kind":"created","text":"对花生过敏","quote":\#(json(quote)),"sourceThreadId":null,"sourceDeleted":false,"at":"2026-10-21T03:00:00.000Z"}"#
        }
        let body = #"{"memoryId":"memory-1","revision":2,"text":"对花生过敏","inference":\#(inference),"sourceThreadId":null,"sourceRefs":[],"category":"health","subCategory":null,"status":"active","recordedAt":"2026-10-21T03:00:00.000Z","lastUsedAt":null,"importBatchId":\#(json(importBatchId)),"history":[\#(history.joined(separator: ","))]}"#
        return try JSONDecoder().decode(MemoryItem.self, from: Data(body.utf8))
    }

    func testSaidUsesTheFirstQuoteFromHistory() throws {
        let basis = MemoryOrganizer.basis(try item(quotes: [nil, "我花生过敏"]), imports: [])
        guard case .said(let date, let quote) = basis else { return XCTFail("\(basis)") }
        XCTAssertNotNil(date)
        XCTAssertEqual(quote, "我花生过敏")
    }

    func testSaidWithoutAQuoteHasNoQuote() throws {
        let basis = MemoryOrganizer.basis(try item(), imports: [])
        guard case .said(_, let quote) = basis else { return XCTFail("\(basis)") }
        XCTAssertNil(quote)
    }

    func testInferredAndImportedAreNotSaid() throws {
        XCTAssertEqual(MemoryOrganizer.basis(try item(inference: true, quotes: ["我花生过敏"]), imports: []), .inferred)
        XCTAssertEqual(
            MemoryOrganizer.basis(
                try item(importBatchId: "batch-1", quotes: ["我花生过敏"]),
                imports: [MemoryImport(batchId: "batch-1", source: "codex")]
            ),
            .imported(source: "codex")
        )
    }

    func testNeverUsedIsSaidPlainly() {
        XCTAssertEqual(M.lastUsed(nil), M.neverUsed)
    }
}
