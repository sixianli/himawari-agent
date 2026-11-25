import XCTest
@testable import HimawariCore

final class TalkTurnTests: XCTestCase {
    private let start = ContinuousClock.now

    func testATurnEndsShortlyAfterAFinalPieceGoesQuiet() {
        var turn = TalkTurn()
        turn.heard("那天大阪", isFinal: false, at: start)
        turn.heard("那天大阪会下雨吗", isFinal: true, at: start + .milliseconds(300))
        XCTAssertFalse(turn.isDone(at: start + .milliseconds(700)))
        XCTAssertTrue(turn.isDone(at: start + .milliseconds(800)))
        XCTAssertEqual(turn.take(), "那天大阪会下雨吗")
        XCTAssertTrue(turn.isEmpty)
    }

    func testAVolatilePieceWaitsLongerBeforeEndingTheTurn() {
        var turn = TalkTurn()
        turn.heard("帮我看下", isFinal: false, at: start)
        XCTAssertFalse(turn.isDone(at: start + .milliseconds(1000)))
        XCTAssertTrue(turn.isDone(at: start + .milliseconds(1500)))
    }

    func testFinalPiecesAccumulateAndAVolatileOneReplacesTheLast() {
        var turn = TalkTurn()
        turn.heard("周五去大阪。", isFinal: true, at: start)
        turn.heard("几点", isFinal: false, at: start)
        turn.heard("几点出门", isFinal: false, at: start)
        XCTAssertEqual(turn.text, "周五去大阪。几点出门")
    }

    func testSilenceAloneNeverEndsATurn() {
        let turn = TalkTurn()
        XCTAssertFalse(turn.isDone(at: start + .seconds(10)))
        var blank = TalkTurn()
        blank.heard("  ", isFinal: true, at: start)
        XCTAssertFalse(blank.isDone(at: start + .seconds(10)))
    }

    func testSpokenTextDropsMarkdownMarksAndStaysAPrefixWhileStreaming() {
        let full = "**大阪**周五晴，`18` 度。\n- 不用带伞"
        XCTAssertEqual(SpokenText.from(markdown: full), "大阪周五晴，18 度。\n- 不用带伞")
        let partial = String(full.prefix(5))
        XCTAssertTrue(SpokenText.from(markdown: full).hasPrefix(SpokenText.from(markdown: partial)))
    }

    func testSpeakingInTheGapBetweenSentencesStopsTheRestOfThatReply() {
        var reply = HerReply()
        XCTAssertEqual(reply.receive("大阪周五晴。", finished: false), ["大阪周五晴。"])
        XCTAssertTrue(reply.ownerSpoke(whileSpeaking: false))
        XCTAssertEqual(reply.receive("大阪周五晴。不用带伞。", finished: false), [])
        XCTAssertEqual(reply.receive("大阪周五晴。不用带伞。记得早点出门", finished: true), [])
    }

    func testSpeakingAfterAFinishedReplyHasBeenReadInterruptsNothing() {
        var reply = HerReply()
        XCTAssertEqual(reply.receive("好的。", finished: true), ["好的。"])
        XCTAssertFalse(reply.ownerSpoke(whileSpeaking: false))
        XCTAssertTrue(reply.ownerSpoke(whileSpeaking: true))
    }

    func testANewReplyIsReadAgainAfterAnInterruption() {
        var reply = HerReply()
        _ = reply.receive("第一句。", finished: false)
        XCTAssertTrue(reply.ownerSpoke(whileSpeaking: true))
        XCTAssertEqual(reply.receive("换个说法。", finished: false), ["换个说法。"])
        XCTAssertFalse(reply.interrupted)
    }
}
