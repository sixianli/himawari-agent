import Testing
@testable import HimawariCore

@Suite struct ReloadGateTests {
    @Test func aChangeDuringALoadIsKeptAndReadOnceMore() {
        var gate = ReloadGate<String>()
        let first = gate.begin("run:1")
        let during = [gate.begin("run:1"), gate.begin("run:1")]
        let again = gate.finish("run:1")
        let done = gate.finish("run:1")
        let next = gate.begin("run:1")
        #expect(first)
        #expect(during == [false, false])
        #expect(again)
        #expect(!done)
        #expect(next)
    }

    @Test func aQuietLoadFinishesWithoutReadingAgain() {
        var gate = ReloadGate<String>()
        let started = gate.begin("run:1")
        let again = gate.finish("run:1")
        #expect(started)
        #expect(!again)
    }

    @Test func differentRunsDoNotWaitForEachOther() {
        var gate = ReloadGate<String>()
        let one = gate.begin("run:1")
        let two = gate.begin("run:2")
        let oneDuring = gate.begin("run:1")
        let twoAgain = gate.finish("run:2")
        let oneAgain = gate.finish("run:1")
        #expect(one && two)
        #expect(!oneDuring)
        #expect(!twoAgain)
        #expect(oneAgain)
    }

    @Test func aFailedLoadLetsTheNextChangeStartAgain() {
        var gate = ReloadGate<String>()
        _ = gate.begin("run:1")
        _ = gate.begin("run:1")
        gate.cancel("run:1")
        let next = gate.begin("run:1")
        #expect(next)
    }
}
