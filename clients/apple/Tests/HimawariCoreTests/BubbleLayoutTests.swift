import Foundation
import Testing
@testable import HimawariCore

@Suite struct BubbleLayoutTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func message(_ id: String, _ speaker: BubbleSpeaker, minute: Double) -> BubbleEntry {
        BubbleEntry(id: id, speaker: speaker, at: start.addingTimeInterval(minute * 60))
    }

    @Test func bubblesInARunSitCloseAndANewSpeakerStartsFurtherDown() {
        let placed = BubbleLayout.place([
            message("q1", .owner, minute: 0),
            message("q2", .owner, minute: 1),
            .step(id: "s1"),
            message("a1", .her, minute: 2),
            message("a2", .her, minute: 3),
            message("q3", .owner, minute: 4),
        ])
        #expect(placed["q1"]?.gapAbove == BubbleGap.none)
        #expect(placed["q2"]?.gapAbove == .inGroup)
        #expect(placed["s1"]?.gapAbove == .newSpeaker)
        #expect(placed["a1"]?.gapAbove == .aroundStep)
        #expect(placed["a2"]?.gapAbove == .inGroup)
        #expect(placed["q3"]?.gapAbove == .newSpeaker)
    }

    @Test func aTimeLineGoesAboveTheStepsOfAMessageSentFifteenMinutesOrMoreLater() {
        let placed = BubbleLayout.place([
            message("q1", .owner, minute: 0),
            message("a1", .her, minute: 1),
            message("q2", .owner, minute: 16),
            .step(id: "s2"),
            message("a2", .her, minute: 32),
        ])
        #expect(placed["q2"]?.timeAbove == start.addingTimeInterval(16 * 60))
        #expect(placed["s2"]?.timeAbove == start.addingTimeInterval(32 * 60))
        #expect(placed["a2"]?.timeAbove == nil)
        #expect(placed["a1"]?.timeAbove == nil)
    }

    @Test func noTimeLineBetweenMessagesLessThanFifteenMinutesApart() {
        let placed = BubbleLayout.place([
            message("q1", .owner, minute: 0),
            message("a1", .her, minute: 14.9),
            message("q2", .owner, minute: 29),
        ])
        #expect(placed.values.allSatisfy { $0.timeAbove == nil })
        #expect(placed["q1"]?.timeAbove == nil)
    }

    @Test func aTimeLineSplitsARun() {
        let placed = BubbleLayout.place([
            message("q1", .owner, minute: 0),
            message("q2", .owner, minute: 30),
        ])
        #expect(placed["q2"]?.gapAbove == .newSpeaker)
    }

    @Test func messagesWithoutATimeStillJoinTheRun() {
        let placed = BubbleLayout.place([
            message("q1", .owner, minute: 0),
            BubbleEntry(id: "queued", speaker: .owner, at: nil),
        ])
        #expect(placed["queued"]?.gapAbove == .inGroup)
    }
}
