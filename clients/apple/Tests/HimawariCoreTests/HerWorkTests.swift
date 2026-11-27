import Foundation
import Testing
@testable import HimawariCore

@Suite struct HerWorkTests {
    private func at(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

    private func period(spoken: Int, rated: Int, useful: Int, unneeded: Int) -> DecisionStats.Period {
        DecisionStats.Period(start: at("2026-11-19T00:00:00Z"), end: at("2026-11-26T00:00:00Z"), spoken: spoken, rated: rated, useful: useful, unneeded: unneeded)
    }

    @Test func decodesWhySheDidSaySomethingAndKeepsUnknownCauseKinds() throws {
        let json = """
        {"type":"decision.spoken.snapshot","payload":{"messageId":"message:said:1","rating":"useful","decisions":[
          {"decisionId":"inbox:a","decidedAt":"2026-11-25T01:00:00.000Z","pushed":true,"reason":"会议改了","cause":{"kind":"mail","at":"2026-11-25T00:59:00.000Z","summary":"来自山田","memoryId":null}},
          {"decisionId":"inbox:b","decidedAt":"2026-11-25T01:00:00.000Z","pushed":true,"reason":"会议改了","cause":{"kind":"memory_saved","at":"2026-11-25T00:58:00.000Z","summary":null,"memoryId":"memory-12"}},
          {"decisionId":"inbox:c","decidedAt":"2026-11-25T01:00:00.000Z","pushed":false,"reason":null,"cause":{"kind":"something_new","at":"2026-11-25T00:58:00.000Z","summary":null,"memoryId":null}}
        ]}}
        """
        let explanation = try SpokenExplanation.decode(Data(json.utf8))
        #expect(explanation.rating == .useful)
        #expect(explanation.decisions.map(\.cause.kind) == [.mail, .memory, .other])
        #expect(explanation.decisions[1].cause.memoryId == "memory-12")
        #expect(explanation.reasons == ["会议改了"])
    }

    @Test func aRatingIsWithheldUntilEnoughMessagesWereRated() {
        let stats = DecisionStats(
            span: .week,
            minimumSamples: 5,
            current: period(spoken: 9, rated: 4, useful: 3, unneeded: 1),
            previous: period(spoken: 2, rated: 0, useful: 0, unneeded: 0),
            recall: nil,
            previousRecall: nil
        )
        #expect(stats.rate(.useful) == .tooFew(4))
        #expect(stats.rateTrend(.useful) == nil)
        #expect(stats.spokenTrend == .up)
        #expect(stats.recallTrend == nil)
    }

    @Test func ratesAndTrendsCompareOnlyWithHerOwnPreviousPeriod() {
        let stats = DecisionStats(
            span: .fourWeeks,
            minimumSamples: 5,
            current: period(spoken: 12, rated: 10, useful: 8, unneeded: 2),
            previous: period(spoken: 12, rated: 5, useful: 2, unneeded: 3),
            recall: .init(at: at("2026-11-25T00:00:00Z"), correct: 24, asked: 30),
            previousRecall: .init(at: at("2026-11-18T00:00:00Z"), correct: 25, asked: 30)
        )
        #expect(stats.rate(.useful) == .value(0.8, rated: 10, of: 12))
        #expect(stats.rate(.unneeded) == .value(0.2, rated: 10, of: 12))
        #expect(stats.rateTrend(.useful) == .up)
        #expect(stats.rateTrend(.unneeded) == .down)
        #expect(stats.spokenTrend == .same)
        #expect(stats.recallTrend == .down)
    }

    @Test func decodesAFilePageAndTreatsUnknownKindsAsOther() throws {
        let json = """
        {"payload":{"files":[
          {"fileId":"thread-artifact:1","threadId":"t1","threadTitle":"周五去大阪","name":"行程.md","kind":"document","origin":"generated","mediaType":"text/markdown","sizeBytes":12,"version":2,"createdAt":"2026-11-24T00:00:00.000Z","deleted":false,"contentPath":"/api/files/v1/content/x"},
          {"fileId":"thread-artifact:2","threadId":"t1","threadTitle":null,"name":"clip.mov","kind":"video","origin":"uploaded","mediaType":"video/quicktime","sizeBytes":1,"version":1,"createdAt":"2026-11-24T00:00:00.000Z","deleted":true,"contentPath":null}
        ],"nextCursor":"abc","generatedAt":"2026-11-26T00:00:00.000Z"}}
        """
        let page = try OwnerFilePage.decode(Data(json.utf8))
        #expect(page.files.map(\.kind) == [.document, .other])
        #expect(page.files.map(\.canOpen) == [true, false])
        #expect(page.nextCursor == "abc")
    }

    @Test func filtersMapToTheServerQueryAndSearchMatchesNamesOnly() {
        #expect(OwnerFileFilter.all.payload.kind == nil)
        #expect(OwnerFileFilter.kind(.image).payload.kind == "image")
        #expect(OwnerFileFilter.uploaded.payload.origin == "uploaded")
        #expect(OwnerFileFilter.choices.first == .all)
        #expect(OwnerFileFilter.choices.last == .uploaded)
        let files = [
            OwnerFile(fileId: "1", threadId: "t", threadTitle: "大阪", name: "Osaka plan.md", kind: .document, origin: .generated, mediaType: "text/markdown", sizeBytes: 1, version: 1, createdAt: Date()),
            OwnerFile(fileId: "2", threadId: "t", threadTitle: "osaka", name: "budget.csv", kind: .data, origin: .generated, mediaType: "text/csv", sizeBytes: 1, version: 1, createdAt: Date()),
        ]
        #expect(OwnerFileFilter.matching(files, search: " osaka ").map(\.fileId) == ["1"])
        #expect(OwnerFileFilter.matching(files, search: "").count == 2)
        #expect(OwnerFileFilter.matching(files, search: "tokyo").isEmpty)
    }

    @Test func onlyAMessageTheServerMarksAsSpokenOffersWhy() throws {
        let base = #"{"messageId":"m","sequence":1,"role":"agent","contentRef":"c","status":"committed","turnId":null,"runId":"r","committedAt":"2026-11-26T00:00:00.000Z""#
        #expect(try JSONDecoder().decode(ThreadMessage.self, from: Data((base + #","spoken":true}"#).utf8)).spoken)
        #expect(try !JSONDecoder().decode(ThreadMessage.self, from: Data((base + #","spoken":false}"#).utf8)).spoken)
        #expect(try !JSONDecoder().decode(ThreadMessage.self, from: Data((base + "}").utf8)).spoken)
    }
}
