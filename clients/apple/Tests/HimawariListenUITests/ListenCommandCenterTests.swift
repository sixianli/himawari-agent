import Foundation
import Testing
@testable import HimawariListenUI

@MainActor
final class CommandLog {
    var ended = 0
    var handled: [ListenCommand] = []
}

@MainActor
struct ListenCommandCenterTests {
    @Test func stopAndPauseFromTheLockScreenEndTheCardWhenTheAppHasNotSetUpListening() async {
        let log = CommandLog()
        let center = ListenCommandCenter(endActivities: { log.ended += 1 })
        await center.perform(.stop)
        await center.perform(.pause)
        #expect(log.ended == 2)
    }

    @Test func answersThatNeedTheListenerDoNothingWithoutIt() async {
        let log = CommandLog()
        let center = ListenCommandCenter(endActivities: { log.ended += 1 })
        await center.perform(.resume)
        await center.perform(.notMe)
        await center.perform(.itsMe)
        #expect(log.ended == 0)
    }

    @Test func commandsGoToTheListenerOnceItExists() async {
        let log = CommandLog()
        let center = ListenCommandCenter(endActivities: { log.ended += 1 })
        center.handler = { command in log.handled.append(command) }
        await center.perform(.stop)
        #expect(log.handled == [.stop])
        #expect(log.ended == 0)
    }

    @Test func aStaleCardIsMarkedSoonAfterTheAppStopsUpdatingIt() {
        let now = Date(timeIntervalSince1970: 1_000)
        let stale = ListenActivityLifetime.staleDate(after: now)
        #expect(stale.timeIntervalSince(now) == ListenActivityLifetime.staleAfter)
        #expect(ListenActivityLifetime.staleAfter <= 180)
        #expect(ListenActivityLifetime.staleAfter > 60)
    }
}
