import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct WatchGlanceTests {
    private func home(_ json: String) throws -> WatchHome {
        try JSONDecoder().decode(WatchHome.self, from: Data(json.utf8))
    }

    private let snapshot = """
    {"items":[
      {"key":"done:1","kind":"done","awaitsOwner":false,"sentence":"整理好了","sentenceBasis":"recorded","source":{"type":"agent","from":null,"label":null,"threadId":null,"decisionId":null,"at":"2026-11-12T06:00:00Z"},"deadline":null,"createdAt":"2026-11-12T06:00:00Z","actions":[],"rank":"recency","dataClassification":"personal"},
      {"key":"insight:7","kind":"heads_up","awaitsOwner":true,"sentence":"周五的会改到 15:00","sentenceBasis":"recorded","source":{"type":"mail","from":"田中","label":"出门提醒要跟着改吗","threadId":null,"decisionId":null,"at":"2026-11-12T06:00:00Z"},"deadline":"2026-11-12T09:40:00.000Z","createdAt":"2026-11-12T06:00:00Z",
       "actions":[{"action":"dismiss","label":"不用","labelBasis":"catalog","polarity":"negative","ownerPresence":false,"binding":"b2"},{"action":"done","label":"改到 9:40","labelBasis":"model","polarity":"positive","ownerPresence":false,"binding":"b1"},{"action":"snooze","label":"稍后","labelBasis":"catalog","polarity":"neutral","ownerPresence":false,"binding":"b3"}],
       "rank":"deadline","dataClassification":"personal"}
    ],"awaitingCount":3,"awaitingTruncated":false,"incompleteSources":[],
    "upcoming":[{"reminderId":"r2","memoryId":"m2","text":"给妈妈打电话","dueAt":"2026-11-12T12:00:00Z","repeat":"none","sourceThreadId":null,"dataClassification":"personal"},{"reminderId":"bad","memoryId":"m","text":"x","dueAt":"not a time"}],
    "revision":"rev1","generatedAt":"2026-11-12T06:00:00Z"}
    """

    @Test func readsTheHomeSnapshotTheServerSendsAndSkipsOnlyTheUnreadableReminder() throws {
        let home = try home(snapshot)
        #expect(home.items.count == 2)
        #expect(home.countedAwaiting == 3)
        #expect(home.upcoming.map(\.reminderId) == ["r2"])
        let pressing = try #require(home.pressing)
        #expect(pressing.key == "insight:7")
        #expect(pressing.detail == "出门提醒要跟着改吗")
        #expect(pressing.deadline == ServerTime.parse("2026-11-12T09:40:00Z"))
    }

    @Test func theCardPutsTheAffirmativeButtonFirstAndShowsAtMostTheSameTwoAsEveryOtherScreen() throws {
        let pressing = try #require(try home(snapshot).pressing)
        let card = try #require(WatchCard(pressing))
        guard case let .decide(actions) = card.choice else {
            Issue.record("expected two buttons")
            return
        }
        #expect(actions.map(\.label) == ["改到 9:40", "不用"])
        #expect(card.sentence == "周五的会改到 15:00")
    }

    @Test func anythingThatNeedsTheOwnerPresentOnlyOffersToOpenItOnTheIPhone() {
        let item = WatchItem(key: "approval:1", awaitsOwner: true, sentence: "给田中回邮件", detail: nil, deadline: nil, actions: [
            HomeAction(action: "approved", label: "同意", polarity: "positive", ownerPresence: true, binding: "a"),
            HomeAction(action: "denied", label: "不同意", polarity: "negative", ownerPresence: false, binding: "b"),
        ])
        #expect(WatchCard(item)?.choice == .handOff)
        let silent = WatchItem(key: "x", awaitsOwner: true, sentence: "要先看内容", detail: nil, deadline: nil, actions: [])
        #expect(WatchCard(silent)?.choice == .handOff)
    }

    @Test func anItemWithoutASentenceIsNeverTheWristCard() throws {
        let json = """
        {"items":[{"key":"approval:9","awaitsOwner":true,"sentence":null,"actions":[]},{"key":"insight:1","awaitsOwner":true,"sentence":"  ","actions":[]}],"awaitingCount":2,"revision":"r"}
        """
        let home = try home(json)
        #expect(home.pressing == nil)
        #expect(home.countedAwaiting == 2)
    }

    @Test func waitingItemsWithoutASentenceAreNotReportedAsNothingWaitingButARealCardIsNot() throws {
        let silent = try home("""
        {"items":[{"key":"approval:9","awaitsOwner":true,"sentence":null,"actions":[]}],"awaitingCount":1,"revision":"r"}
        """)
        #expect(silent.awaitsOwnerWithoutCard)
        let quiet = try home("""
        {"items":[{"key":"done:1","awaitsOwner":false,"sentence":"好了","actions":[]}],"awaitingCount":0,"revision":"r"}
        """)
        #expect(!quiet.awaitsOwnerWithoutCard)
        #expect(!(try home(snapshot)).awaitsOwnerWithoutCard)
    }

    @Test func theCountIsHiddenWhenTheServerCouldNotReadEverySourceLikeTheIPhoneBadge() throws {
        let json = """
        {"items":[],"awaitingCount":4,"incompleteSources":["mail"],"revision":"r"}
        """
        let state = WatchComplicationState(home: try home(json), at: Date(timeIntervalSince1970: 0))
        #expect(state.display == .unknown)
        let none = WatchComplicationState(home: WatchHome(items: [], awaitingCount: 0, revision: "r"), at: Date(timeIntervalSince1970: 0))
        #expect(none.display == .nothingWaiting)
        let some = WatchComplicationState(home: try home(snapshot), at: Date(timeIntervalSince1970: 0))
        #expect(some.display == .waiting(count: 3, latest: "周五的会改到 15:00"))
    }

    @Test func complicationStateSurvivesTheSharedStoreRoundTrip() throws {
        let state = WatchComplicationState(awaiting: 2, latest: "该出门了", updatedAt: Date(timeIntervalSince1970: 1_800_000_000))
        let data = try JSONEncoder().encode(state)
        #expect(try JSONDecoder().decode(WatchComplicationState.self, from: data) == state)
    }

    @Test func remindersAreScheduledOnlyInTheFutureOncePerReminderEarliestFirstAndWithinTheSystemLimit() {
        let now = Date(timeIntervalSince1970: 1_000)
        let list = [
            WatchUpcoming(reminderId: "late", text: "b", due: Date(timeIntervalSince1970: 3_000)),
            WatchUpcoming(reminderId: "past", text: "a", due: Date(timeIntervalSince1970: 500)),
            WatchUpcoming(reminderId: "soon", text: "c", due: Date(timeIntervalSince1970: 2_000)),
            WatchUpcoming(reminderId: "soon", text: "c", due: Date(timeIntervalSince1970: 2_000)),
            WatchUpcoming(reminderId: "blank", text: "  ", due: Date(timeIntervalSince1970: 2_500)),
        ]
        #expect(WatchReminderPlan.due(list, after: now, limit: 64).map(\.reminderId) == ["soon", "late"])
        #expect(WatchReminderPlan.due(list, after: now, limit: 1).map(\.reminderId) == ["soon"])
        #expect(WatchReminderPlan.due(list, after: now, limit: -1).isEmpty)
    }

    private func message(_ id: String, _ sequence: Int, _ role: MessageRole, _ status: MessageStatus = .committed) -> ThreadMessage {
        ThreadMessage(messageId: id, sequence: sequence, role: role, contentRef: "ref-\(id)", status: status, turnId: nil, runId: nil, committedAt: "2026-11-12T06:00:00Z")
    }

    private func detail(_ messages: [ThreadMessage]) -> ThreadDetail {
        let thread = ThreadSummary(threadId: "t", revision: 1, status: .active, titleRef: nil, pinOrder: nil, answerLocale: "zh-CN", messageWatermark: 0, createdAt: "", updatedAt: "")
        return ThreadDetail(thread: thread, messages: messages, runs: [], nextSequence: nil)
    }

    @Test func theReplyIsTheFirstFinishedAnswerAfterWhatTheOwnerSaid() {
        #expect(WatchReply.state(in: detail([]), after: "mine") == .waiting)
        #expect(WatchReply.state(in: detail([message("old", 1, .agent), message("mine", 2, .owner)]), after: "mine") == .waiting)
        #expect(WatchReply.state(in: detail([message("mine", 2, .owner), message("a", 3, .agent, .partial)]), after: "mine") == .waiting)
        #expect(WatchReply.state(in: detail([message("mine", 2, .owner), message("b", 5, .agent), message("a", 4, .agent)]), after: "mine") == .answered(contentRef: "ref-a"))
        #expect(WatchReply.state(in: detail([message("mine", 2, .owner), message("a", 3, .agent, .failed)]), after: "mine") == .failed)
    }

    @Test func theFirstSentenceStopsAtTheFirstSentenceEnd() {
        #expect(WatchReply.firstSentence("会面定在 14:00。新大阪站附近有三家咖啡店") == "会面定在 14:00。")
        #expect(WatchReply.firstSentence("Meeting is at 2.30 today. Then lunch.") == "Meeting is at 2.30 today.")
        #expect(WatchReply.firstSentence("第一行\n第二行") == "第一行")
        #expect(WatchReply.firstSentence("  没有句号  ") == "没有句号")
    }

    @Test func onlyAValidPairingLinkIsTakenFromTheIPhone() throws {
        let link = try PairingTestLink.make()
        #expect(WatchPairingRelay.link(in: WatchPairingRelay.message(link)) == link)
        #expect(WatchPairingRelay.link(in: [WatchPairingRelay.key: "himawari-pair:nonsense"]) == nil)
        #expect(WatchPairingRelay.link(in: ["other": link]) == nil)
    }

    @Test func watchHomeReadsTheSameEndpointAsTheMacPanelAndActsByKey() async throws {
        let exchange = RecordingExchange([
            HTTPExchangeResponse(status: 200, body: Data(snapshot.utf8)),
            HTTPExchangeResponse(status: 200, body: Data("{}".utf8)),
        ])
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        let api = DeviceAPI(http: http)
        let home = try await api.watchHome(locale: "ja")
        let action = try #require(home.pressing?.actions.first)
        try await api.act(key: "insight:7", action: action, requestId: "req_AAAAAAAAAAAAAAAA")
        let read = try #require(exchange.requests.first?.url)
        #expect(read.path == "/api/device/v1/home")
        #expect(read.query == "locale=ja")
        let sent = try #require(exchange.requests.last)
        #expect(sent.url?.path == "/api/device/v1/home/act")
        let sentBody = try #require(sent.httpBody)
        let object = try JSONSerialization.jsonObject(with: sentBody)
        let body = try #require(object as? [String: String])
        #expect(body == ["key": "insight:7", "action": "dismiss", "binding": "b2", "requestId": "req_AAAAAAAAAAAAAAAA"])
    }

    @Test func textFitsWhenItFitsTheScreenAndNotOtherwise() {
        #expect(WatchTextFit.fits("好的", width: 180, height: 120, fontSize: 16, lineHeight: 20))
        let long = String(repeating: "很长的回答", count: 40)
        #expect(!WatchTextFit.fits(long, width: 180, height: 120, fontSize: 16, lineHeight: 20))
        #expect(WatchTextFit.fits(long, width: 400, height: 2000, fontSize: 16, lineHeight: 20))
        #expect(!WatchTextFit.fits("a", width: 0, height: 100, fontSize: 16, lineHeight: 20))
        #expect(!WatchTextFit.fits("a\nb\nc", width: 100, height: 40, fontSize: 16, lineHeight: 20))
    }

    @Test func complicationStoreReturnsUnknownUntilSomethingWasSaved() {
        let store = WatchComplicationStore(appGroup: "himawari.test.\(UUID().uuidString)")
        #expect(store.load().display == .unknown)
        let state = WatchComplicationState(awaiting: 1, latest: "x", updatedAt: Date(timeIntervalSince1970: 5))
        store.save(state)
        #expect(store.load() == state)
    }
}

enum PairingTestLink {
    static func make() throws -> String {
        let envelope: [String: Any] = ["v": 1, "origin": "https://himawari.example.test", "code": "AAAAAAAAAAAAAAAAAAAAAA"]
        let data = try JSONSerialization.data(withJSONObject: envelope)
        let encoded = data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "\(PairingInvitation.scheme):\(encoded)"
    }
}
