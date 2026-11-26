import XCTest
@testable import HimawariCore

final class TalkTurnTests: XCTestCase {
    private let start = ContinuousClock.now

    func testATurnEndsShortlyAfterAFinalPieceGoesQuiet() {
        var turn = TalkTurn()
        turn.heard("那天大阪", isFinal: false, from: 0, to: 1, at: start)
        turn.heard("那天大阪会下雨吗", isFinal: true, from: 0, to: 2, at: start + .milliseconds(300))
        XCTAssertFalse(turn.isDone(at: start + .milliseconds(700)))
        XCTAssertTrue(turn.isDone(at: start + .milliseconds(800)))
        XCTAssertEqual(turn.take(), "那天大阪会下雨吗")
        XCTAssertTrue(turn.isEmpty)
    }

    func testAVolatilePieceWaitsLongerBeforeEndingTheTurn() {
        var turn = TalkTurn()
        turn.heard("帮我看下", isFinal: false, from: 0, to: 1, at: start)
        XCTAssertFalse(turn.isDone(at: start + .milliseconds(1000)))
        XCTAssertTrue(turn.isDone(at: start + .milliseconds(1500)))
    }

    func testFinalPiecesAccumulateAndAVolatileOneReplacesTheLast() {
        var turn = TalkTurn()
        turn.heard("周五去大阪。", isFinal: true, from: 0, to: 1, at: start)
        turn.heard("几点", isFinal: false, from: 1.2, to: 1.6, at: start)
        turn.heard("几点出门", isFinal: false, from: 1.2, to: 2, at: start)
        XCTAssertEqual(turn.text, "周五去大阪。几点出门")
    }

    func testSilenceAloneNeverEndsATurn() {
        let turn = TalkTurn()
        XCTAssertFalse(turn.isDone(at: start + .seconds(10)))
        var blank = TalkTurn()
        blank.heard("  ", isFinal: true, from: 0, to: 1, at: start)
        XCTAssertFalse(blank.isDone(at: start + .seconds(10)))
    }

    func testALateFinalForSpeechAlreadySentIsNotSentAgain() {
        var turn = TalkTurn()
        turn.heard("我在纠结到到底要不要去上课", isFinal: false, from: 0, to: 2.4, at: start)
        XCTAssertTrue(turn.isDone(at: start + .milliseconds(1500)))
        XCTAssertEqual(turn.take(), "我在纠结到到底要不要去上课")
        turn.heard("我在纠结到到底要不要去上课。", isFinal: true, from: 0, to: 2.6, at: start + .milliseconds(1800))
        XCTAssertTrue(turn.isEmpty)
        XCTAssertFalse(turn.isDone(at: start + .seconds(5)))
    }

    func testSpeechThatGoesOnInTheSameStretchKeepsOnlyTheNewWords() {
        var turn = TalkTurn()
        turn.heard("周五去大阪", isFinal: false, from: 0, to: 1.5, at: start)
        XCTAssertEqual(turn.take(), "周五去大阪")
        turn.heard("周五去大阪，几点出门", isFinal: false, from: 0, to: 3, at: start + .seconds(2))
        XCTAssertEqual(turn.text, "几点出门")
        turn.heard("周五去大阪，几点出门？", isFinal: true, from: 0, to: 3.2, at: start + .seconds(3))
        XCTAssertEqual(turn.take(), "几点出门？")
        turn.heard("周五去大阪，几点出门？", isFinal: true, from: 0, to: 3.2, at: start + .seconds(4))
        XCTAssertTrue(turn.isEmpty)
    }

    func testNewSpeechAfterASendIsKeptWhole() {
        var turn = TalkTurn()
        turn.heard("那天大阪会下雨吗", isFinal: true, from: 0, to: 2, at: start)
        XCTAssertEqual(turn.take(), "那天大阪会下雨吗")
        turn.heard("那要带伞吗", isFinal: true, from: 3, to: 4, at: start + .seconds(3))
        XCTAssertEqual(turn.take(), "那要带伞吗")
    }

    func testWhatWasHeardBeforeMutingIsNotSentWhenItsFinalArrivesLater() {
        var turn = TalkTurn()
        turn.heard("先别听", isFinal: false, from: 0, to: 1, at: start)
        turn.drop()
        turn.heard("先别听。", isFinal: true, from: 0, to: 1.1, at: start + .seconds(1))
        XCTAssertTrue(turn.isEmpty)
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
