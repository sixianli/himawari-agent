import Foundation
import Testing

@testable import HimawariCore

final class FakeNotificationCenter: DeliveredNotificationCenter, @unchecked Sendable {
    private let lock = NSLock()
    private var shown: [DeliveredNotification]

    init(_ shown: [DeliveredNotification]) { self.shown = shown }

    func delivered() async -> [DeliveredNotification] { lock.withLock { shown } }

    func remove(requestIdentifiers: [String]) async {
        lock.withLock { shown.removeAll { requestIdentifiers.contains($0.requestIdentifier) } }
    }

    var remaining: [String] { lock.withLock { shown.map(\.requestIdentifier) } }
}

final class FakeSettlement: NotificationSettlementSource, @unchecked Sendable {
    private let lock = NSLock()
    private let settled: Set<String>
    private let failing: Bool
    private(set) var asked: [[String]] = []

    init(settled: Set<String>, failing: Bool = false) {
        self.settled = settled
        self.failing = failing
    }

    func settledNotifications(ids: [String]) async throws -> [String] {
        lock.withLock { asked.append(ids) }
        if failing { throw URLError(.notConnectedToInternet) }
        return ids.filter { settled.contains($0) }
    }
}

@Suite struct NotificationSettlingTests {
    func shown(_ pairs: [(String, String?)]) -> [DeliveredNotification] {
        pairs.map { DeliveredNotification(requestIdentifier: $0.0, notificationId: $0.1) }
    }

    @Test func aWithdrawPushRemovesTheNotificationWithThatIdentifierAndLeavesTheOthers() async {
        let center = FakeNotificationCenter(shown([("r1", "n1"), ("r2", "n2"), ("r3", nil)]))
        await NotificationSettler(center: center).withdraw(notificationId: "n1")
        #expect(center.remaining == ["r2", "r3"])
    }

    @Test func aWithdrawPushForAnIdentifierThatIsNotShownRemovesNothing() async {
        let center = FakeNotificationCenter(shown([("r1", "n1")]))
        await NotificationSettler(center: center).withdraw(notificationId: "other")
        #expect(center.remaining == ["r1"])
    }

    @Test func comingBackToTheForegroundRemovesSettledNotificationsAndKeepsTheOpenOnes() async {
        let center = FakeNotificationCenter(shown([("r1", "settled"), ("r2", "open"), ("r3", nil)]))
        let source = FakeSettlement(settled: ["settled"])
        let removed = await NotificationSettler(center: center, source: source).reconcile()
        #expect(removed == 1)
        #expect(center.remaining == ["r2", "r3"])
        #expect(source.asked == [["settled", "open"]])
    }

    @Test func aServerReplyNamingAnIdentifierThatWasNotAskedAboutRemovesNothingExtra() async {
        let center = FakeNotificationCenter(shown([("r1", "asked")]))
        let source = FakeSettlement(settled: ["asked", "stranger"])
        _ = await NotificationSettler(center: center, source: source).reconcile()
        #expect(center.remaining == [])
        let other = FakeNotificationCenter(shown([("r9", "unrelated")]))
        let reply = FakeSettlement(settled: ["stranger"])
        #expect(await NotificationSettler(center: other, source: reply).reconcile() == 0)
        #expect(other.remaining == ["r9"])
    }

    @Test func aFailedCheckLeavesEveryNotificationInPlace() async {
        let center = FakeNotificationCenter(shown([("r1", "n1")]))
        let source = FakeSettlement(settled: ["n1"], failing: true)
        #expect(await NotificationSettler(center: center, source: source).reconcile() == 0)
        #expect(center.remaining == ["r1"])
    }

    @Test func theCheckAsksAboutAtMostTwoHundredIdentifiersAtATimeAndAboutEachOnce() async {
        let items = (0 ..< 450).map { ("r\($0)", Optional("n\($0 % 430)")) }
        let center = FakeNotificationCenter(shown(items))
        let source = FakeSettlement(settled: [])
        _ = await NotificationSettler(center: center, source: source).reconcile()
        #expect(source.asked.map(\.count) == [200, 200, 30])
        #expect(Set(source.asked.flatMap { $0 }).count == 430)
    }

    @Test func nothingShownMeansNoServerCall() async {
        let source = FakeSettlement(settled: [])
        #expect(await NotificationSettler(center: FakeNotificationCenter([]), source: source).reconcile() == 0)
        #expect(source.asked.isEmpty)
    }

    @Test func onlyASilentPushWithAnIdentifierCountsAsAWithdrawal() {
        let silent: [AnyHashable: Any] = ["aps": ["content-available": 1], "notificationId": "n1"]
        #expect(SilentWithdrawPush.notificationId(in: silent) == "n1")
        let visible: [AnyHashable: Any] = ["aps": ["alert": "hi", "content-available": 1], "notificationId": "n1"]
        #expect(SilentWithdrawPush.notificationId(in: visible) == nil)
        let noFlag: [AnyHashable: Any] = ["aps": [:], "notificationId": "n1"]
        #expect(SilentWithdrawPush.notificationId(in: noFlag) == nil)
        let noId: [AnyHashable: Any] = ["aps": ["content-available": 1]]
        #expect(SilentWithdrawPush.notificationId(in: noId) == nil)
    }

    @Test func theSettledCheckPostsTheIdentifiersToTheDeviceRoute() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(#"{"settledIds":["n1"]}"#.utf8))])
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        let settled = try await DeviceAPI(http: http).settledNotifications(ids: ["n1", "n2"])
        #expect(settled == ["n1"])
        let request = try #require(exchange.requests.first)
        #expect(request.url?.path == "/api/device/v1/notifications/settled")
        #expect(request.httpMethod == "POST")
        let body = try #require(JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: Any])
        #expect(body["ids"] as? [String] == ["n1", "n2"])
    }
}
