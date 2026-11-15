import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct DeviceNotificationStreamTests {
    private static let deliver = #"{"id":"n-1","kind":"reminder","title":"该出门了","body":"大约 25 分钟","homeKey":null,"createdAt":"2026-11-15T05:35:00.000Z"}"#

    @Test func deliverAndWithdrawDecodeFromTheirEventNames() throws {
        let deliver = DeviceEventDecoder.decode(ServerSentEvent(event: "notification.deliver", data: Self.deliver, id: nil))
        #expect(deliver == .notificationDeliver(DeviceNotification(id: "n-1", kind: "reminder", title: "该出门了", body: "大约 25 分钟", homeKey: nil, createdAt: "2026-11-15T05:35:00.000Z")))
        let withdraw = DeviceEventDecoder.decode(ServerSentEvent(event: "notification.withdraw", data: #"{"id":"n-1"}"#, id: nil))
        #expect(withdraw == .notificationWithdraw(id: "n-1"))
    }

    @Test func malformedNotificationPayloadsAreIgnored() {
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "notification.deliver", data: #"{"id":"n-1"}"#, id: nil)) == nil)
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "notification.withdraw", data: "{}", id: nil)) == nil)
    }

    @Test func notificationEventsReachTheStreamWithoutMovingTheCursor() async throws {
        let lines = [
            "event: heartbeat\nid: cursor-7\ndata: {}\n\n",
            "event: notification.deliver\nid: n-1\ndata: \(Self.deliver)\n\n",
            "event: notification.deliver\nid: n-bad\ndata: {\"id\":\"n-bad\"}\n\n",
            "event: notification.withdraw\nid: n-1\ndata: {\"id\":\"n-1\"}\n\n",
        ]
        let exchange = RecordingExchange([], streams: [(200, lines)])
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        let cursor = StoredCursor(store: MemoryLocalStore())
        let stream = DeviceEventStream(http: http, cursors: cursor, heartbeat: { 30 })
        var events: [DeviceStreamEvent] = []
        for await event in stream.start() {
            events.append(event)
            if case .notificationWithdraw = event { stream.stop() }
        }
        #expect(events.contains(.notificationWithdraw(id: "n-1")))
        #expect(events.contains { if case .notificationDeliver = $0 { return true } else { return false } })
        #expect(cursor.load() == "cursor-7")
    }
}

@Suite struct PendingNotificationsTests {
    @Test func receivedTimeReadsBothTimestampShapesAndNothingElse() {
        let withMilliseconds = DeviceNotification(id: "a", kind: "reminder", title: "", body: "", homeKey: nil, createdAt: "2026-11-15T05:35:00.250Z")
        let withoutMilliseconds = DeviceNotification(id: "b", kind: "reminder", title: "", body: "", homeKey: nil, createdAt: "2026-11-15T05:35:00Z")
        let broken = DeviceNotification(id: "c", kind: "reminder", title: "", body: "", homeKey: nil, createdAt: "yesterday")
        #expect(withMilliseconds.createdDate == Date(timeIntervalSince1970: 1_794_720_900.25))
        #expect(withoutMilliseconds.createdDate == Date(timeIntervalSince1970: 1_794_720_900))
        #expect(broken.createdDate == nil)
    }

    private func notice(_ id: String, at time: String, homeKey: String? = nil, title: String = "t") -> DeviceNotification {
        DeviceNotification(id: id, kind: "reminder", title: title, body: "", homeKey: homeKey, createdAt: time)
    }

    @Test func newestFirstAndRedeliveryOfTheSameNoticeIsNotNew() {
        var pending = PendingNotifications()
        let first = pending.deliver(notice("a", at: "2026-11-15T05:00:00.000Z"))
        let second = pending.deliver(notice("b", at: "2026-11-15T05:10:00.000Z"))
        let again = pending.deliver(notice("a", at: "2026-11-15T05:00:00.000Z"))
        #expect(first)
        #expect(second)
        #expect(!again)
        #expect(pending.items.map(\.id) == ["b", "a"])
    }

    @Test func changedRedeliveryReplacesTheOldOne() {
        var pending = PendingNotifications()
        pending.deliver(notice("a", at: "2026-11-15T05:00:00.000Z", title: "old"))
        let replaced = pending.deliver(notice("a", at: "2026-11-15T05:00:00.000Z", title: "new"))
        #expect(replaced)
        #expect(pending.items.map(\.title) == ["new"])
    }

    @Test func aNoticeDismissedOrWithdrawnIsNotShownAgainWhenRedelivered() {
        var pending = PendingNotifications()
        pending.deliver(notice("a", at: "2026-11-15T05:00:00.000Z"))
        pending.withdraw("a")
        let again = pending.deliver(notice("a", at: "2026-11-15T05:00:00.000Z"))
        pending.withdraw("early")
        let late = pending.deliver(notice("early", at: "2026-11-15T05:10:00.000Z"))
        #expect(!again)
        #expect(!late)
        #expect(pending.items.isEmpty)
    }

    @Test func aNoticeSettledBeforeARestartIsNotShownAgainAfterIt() {
        let store = MemoryLocalStore()
        var before = PendingNotifications(rememberingIn: store)
        before.deliver(notice("dismissed", at: "2026-11-15T05:00:00.000Z"))
        before.withdraw("dismissed")
        before.withdraw("withdrawn")
        var after = PendingNotifications(rememberingIn: store)
        let dismissed = after.deliver(notice("dismissed", at: "2026-11-15T05:00:00.000Z"))
        let withdrawn = after.deliver(notice("withdrawn", at: "2026-11-15T05:10:00.000Z"))
        let fresh = after.deliver(notice("fresh", at: "2026-11-15T05:20:00.000Z"))
        #expect(!dismissed)
        #expect(!withdrawn)
        #expect(fresh)
        #expect(after.items.map(\.id) == ["fresh"])
    }

    @Test func noticesSettledBeforeTheStoreWasReadyAreKeptAndTheirRowsLeave() {
        let store = MemoryLocalStore()
        var earlier = PendingNotifications(rememberingIn: store)
        earlier.withdraw("saved")
        var pending = PendingNotifications()
        pending.deliver(notice("saved", at: "2026-11-15T05:00:00.000Z"))
        pending.withdraw("in-memory")
        pending.remember(in: store)
        var restarted = PendingNotifications(rememberingIn: store)
        let saved = restarted.deliver(notice("saved", at: "2026-11-15T05:00:00.000Z"))
        let inMemory = restarted.deliver(notice("in-memory", at: "2026-11-15T05:00:00.000Z"))
        #expect(pending.items.isEmpty)
        #expect(!saved)
        #expect(!inMemory)
    }

    @Test func onlyTheLatestSettledIdsAreKept() {
        let store = MemoryLocalStore()
        var pending = PendingNotifications(rememberingIn: store)
        for index in 0...PendingNotifications.settledLimit { pending.withdraw("n-\(index)") }
        let saved = try? JSONDecoder().decode([String].self, from: store.read(PendingNotifications.settledName) ?? Data())
        #expect(saved?.count == PendingNotifications.settledLimit)
        #expect(saved?.first == "n-1")
        let oldest = pending.deliver(notice("n-0", at: "2026-11-15T05:00:00.000Z"))
        let kept = pending.deliver(notice("n-1", at: "2026-11-15T05:00:00.000Z"))
        #expect(oldest)
        #expect(!kept)
    }

    @Test func orderFollowsTheTimeEvenWhenTheFractionalSecondsAreLeftOut() {
        var pending = PendingNotifications()
        pending.deliver(notice("whole", at: "2026-11-15T05:35:00Z"))
        pending.deliver(notice("half", at: "2026-11-15T05:35:00.500Z"))
        pending.deliver(notice("earlier", at: "2026-11-15T05:34:59.900Z"))
        #expect(pending.items.map(\.id) == ["half", "whole", "earlier"])
    }

    @Test func withdrawRemovesOnlyThatNotice() {
        var pending = PendingNotifications()
        pending.deliver(notice("a", at: "2026-11-15T05:00:00.000Z"))
        pending.deliver(notice("b", at: "2026-11-15T05:10:00.000Z"))
        let removed = pending.withdraw("a")
        let missing = pending.withdraw("missing")
        #expect(removed?.id == "a")
        #expect(missing == nil)
        #expect(pending.items.map(\.id) == ["b"])
    }
}

@Suite struct PresenceReportPolicyTests {
    private let policy = PresenceReportPolicy.standard
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func firstReadingIsAlwaysReported() {
        #expect(policy.shouldReport(lastInputAt: start, now: start, lastReport: nil, streamConnected: false))
    }

    @Test func aNewerInputIsReportedOnlyAfterTheMinimumInterval() {
        let sent = PresenceReport(lastInputAt: start, sentAt: start)
        let later = start.addingTimeInterval(10)
        #expect(!policy.shouldReport(lastInputAt: later, now: later, lastReport: sent, streamConnected: true))
        let interval = start.addingTimeInterval(15)
        #expect(policy.shouldReport(lastInputAt: interval, now: interval, lastReport: sent, streamConnected: false))
    }

    @Test func unchangedInputIsResentOnlyAsAKeepAliveWhileTheStreamIsConnected() {
        let sent = PresenceReport(lastInputAt: start, sentAt: start)
        let threeMinutes = start.addingTimeInterval(180)
        #expect(!policy.shouldReport(lastInputAt: start, now: threeMinutes, lastReport: sent, streamConnected: true))
        let fourMinutes = start.addingTimeInterval(240)
        #expect(policy.shouldReport(lastInputAt: start, now: fourMinutes, lastReport: sent, streamConnected: true))
        #expect(!policy.shouldReport(lastInputAt: start, now: fourMinutes, lastReport: sent, streamConnected: false))
    }

    @Test func whileTheOwnerKeepsTypingTheServerNeverSeesAnInputOlderThanItsShortestWindowAllows() {
        let networkAllowance: TimeInterval = 10
        var now = start
        var lastReport: PresenceReport?
        var oldestSeenByServer: TimeInterval = 0
        while now.timeIntervalSince(start) < 600 {
            if let lastReport { oldestSeenByServer = max(oldestSeenByServer, now.timeIntervalSince(lastReport.lastInputAt)) }
            if policy.shouldReport(lastInputAt: now, now: now, lastReport: lastReport, streamConnected: true) {
                lastReport = PresenceReport(lastInputAt: now, sentAt: now)
            }
            now = now.addingTimeInterval(policy.secondsUntilNextCheck(now: now, lastReport: lastReport))
        }
        #expect(oldestSeenByServer > 0)
        #expect(oldestSeenByServer + networkAllowance <= PresenceReportPolicy.shortestServerWindow)
    }

    @Test func anUnreadableIdleTimeIsNotTakenAsInputJustNow() {
        #expect(PresenceReport.lastInput(secondsSinceInput: -1, now: start) == nil)
        #expect(PresenceReport.lastInput(secondsSinceInput: .nan, now: start) == nil)
        #expect(PresenceReport.lastInput(secondsSinceInput: .infinity, now: start) == nil)
        #expect(PresenceReport.lastInput(secondsSinceInput: 0, now: start) == start)
    }

    @Test func theNextCheckLandsOnTheKeepAliveInsteadOfAfterIt() {
        #expect(policy.secondsUntilNextCheck(now: start, lastReport: nil) == 3.75)
        let sent = PresenceReport(lastInputAt: start, sentAt: start)
        #expect(policy.secondsUntilNextCheck(now: start.addingTimeInterval(100), lastReport: sent) == 3.75)
        #expect(policy.secondsUntilNextCheck(now: start.addingTimeInterval(238), lastReport: sent) == 2)
        #expect(policy.secondsUntilNextCheck(now: start.addingTimeInterval(240), lastReport: sent) == 3.75)
    }

    @Test func subSecondJitterInTheIdleReadingIsNotAChange() throws {
        let sent = PresenceReport(lastInputAt: start.addingTimeInterval(0.2), sentAt: start)
        let later = start.addingTimeInterval(90)
        let jittered = try #require(PresenceReport.lastInput(secondsSinceInput: 89.6, now: later))
        #expect(!policy.shouldReport(lastInputAt: jittered, now: later, lastReport: sent, streamConnected: false))
    }

    @Test func reportSendsTheLastInputTimeAsUTCMilliseconds() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(#"{"ok":true,"serverTime":"2027-01-15T08:00:00.000Z"}"#.utf8))])
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        try await DeviceAPI(http: http).reportPresence(lastInputAt: Date(timeIntervalSince1970: 1_800_000_000.75))
        let request = try #require(exchange.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/device/v1/presence")
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
        #expect(body == ["lastInputAt": "2027-01-15T08:00:00.000Z"])
    }
}
