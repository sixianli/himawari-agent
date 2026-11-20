import Foundation
import HimawariCore
import Testing
@testable import HimawariSenses

struct SenseLinesTests {
    private let arrived = 1_763_000_000_000.0

    private func evidence(_ pairs: [(String, String)]) -> [[String: String]] {
        pairs.map { ["name": $0.0, "value": $0.1] }
    }

    private func row(_ id: String, _ type: String, _ evidence: [[String: String]], text: String? = nil) -> [String: Any] {
        [
            "kind": "record",
            "at": "2025-11-13T03:00:00Z",
            "record": [
                "id": id, "type": type, "sense": "location", "occurredAt": "2025-11-13T03:00:00.123Z",
                "deviceId": "iphone", "text": text ?? NSNull(), "textTruncated": false, "evidence": evidence,
            ] as [String: Any],
        ]
    }

    private func day(_ rows: [[String: Any]]) throws -> PerceptionDaySnapshot {
        let data = try JSONSerialization.data(withJSONObject: ["day": "2025-11-13", "total": rows.count, "rows": rows, "nextCursor": NSNull()])
        return try JSONDecoder().decode(PerceptionDaySnapshot.self, from: data)
    }

    @Test func visitArrivalAndDepartureCollapseIntoOneLine() throws {
        let lines = SenseLines.lines(try day([
            row("arrival", "location.visit", evidence([("arrivedAtMs", String(Int(arrived))), ("placeName", "Office")])),
            row("departure", "location.visit", evidence([
                ("arrivedAtMs", String(Int(arrived))), ("departedAtMs", String(Int(arrived + 13_980_000))), ("placeName", "Office"),
            ])),
        ]))
        #expect(lines.map(\.id) == ["departure"])
        #expect(lines[0].at == Date(timeIntervalSince1970: arrived / 1000))
        #expect(lines[0].title.contains("Office"))
    }

    @Test func linesAreOrderedByTimeAndKeepEveryKind() throws {
        let lines = SenseLines.lines(try day([
            row("steps", "health.sample", evidence([("subtype", "steps"), ("value", "4210")])),
            row("visit", "location.visit", evidence([("arrivedAtMs", String(Int(arrived)))])),
            row("copy", "clipboard.item", [], text: "hello"),
        ]))
        #expect(lines.map(\.id) == ["visit", "copy", "steps"])
        #expect(lines[1].title.contains("hello"))
        #expect(lines[2].title.contains("4,210") || lines[2].title.contains("4210"))
    }

    @Test func recordsWithoutReadableTimeAreLeftOut() throws {
        var broken = row("broken", "photo.asset", [])
        var record = broken["record"] as! [String: Any]
        record["occurredAt"] = "yesterday"
        broken["record"] = record
        #expect(SenseLines.lines(try day([broken])).isEmpty)
    }

    @Test func durationsKeepHoursAndMinutesAndRoundUpToAMinute() {
        let both = SenseLines.duration(3 * 3600 + 53 * 60)
        #expect(both.contains("3") && both.contains("53"))
        #expect(SenseLines.duration(30 * 60).contains("30"))
        #expect(!SenseLines.duration(2 * 3600).contains("0 "))
        #expect(SenseLines.duration(10).contains("1"))
    }
}
