import Foundation
import Testing
@testable import HimawariCore

@MainActor
@Suite struct OfflineNoticeTests {
    @Test func aBriefDropThatReconnectsWithinTheGraceShowsNothing() async throws {
        let notice = OfflineNotice(grace: 0.2)
        notice.connectionChanged(online: false)
        try await Task.sleep(nanoseconds: 50_000_000)
        notice.connectionChanged(online: true)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(notice.shown == false)
    }

    @Test func staysOfflinePastTheGraceThenTheNoticeShowsAndClearsOnReconnect() async throws {
        let notice = OfflineNotice(grace: 0.05)
        notice.connectionChanged(online: false)
        #expect(notice.shown == false)
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(notice.shown == true)
        notice.connectionChanged(online: true)
        #expect(notice.shown == false)
    }
}
