import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct BackgroundWorkTests {
    private func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    private static let snapshot = """
    {"schemaVersion":"thread.v3","kind":"snapshot","type":"thread.background_work_snapshot","messageId":"m","payload":{"generatedAt":"2026-11-25T12:00:00.000Z","work":{"matters":[
      {"matter":"12 月 3 日大阪出差","subthreads":[
        {"subthreadId":"sub-a","status":"open","activity":"running","openedAt":"2026-11-25T10:00:00.000Z","updatedAt":"2026-11-25T11:30:00.000Z","progress":"在比价","progressAt":"2026-11-25T11:20:00.000Z","runCount":2,"spentMicros":70000,"budgetMicros":300000,"title":"订机票",
         "runs":[{"runId":"run-1","status":"completed","startedAt":"2026-11-25T10:00:00.000Z","updatedAt":"2026-11-25T10:05:00.000Z"},{"runId":"run-2","status":"running","startedAt":"2026-11-25T11:00:00.000Z","updatedAt":"2026-11-25T11:30:00.000Z"}],
         "exchanges":[{"direction":"to_subthread","kind":"brief","text":"订 3 日早上的机票","at":"2026-11-25T10:00:00.000Z"},{"direction":"to_main","kind":"result_board","text":"三班可选","at":"2026-11-25T11:10:00.000Z"}],
         "tasks":[{"number":1,"status":"completed","subject":"查航班","activeForm":null},{"number":2,"status":"in_progress","subject":"比价","activeForm":"正在比三班的价格"},{"number":3,"status":"pending","subject":"订票","activeForm":null}]},
        {"subthreadId":"sub-b","status":"open","activity":"over_budget","openedAt":"2026-11-25T10:00:00.000Z","updatedAt":"2026-11-25T11:00:00.000Z","progress":null,"progressAt":null,"runCount":1,"spentMicros":500000,"budgetMicros":300000,"title":null,"runs":[],"exchanges":[],"tasks":[]}
      ]},
      {"matter":"整理发票","subthreads":[
        {"subthreadId":"sub-c","status":"returned","activity":"finished","openedAt":"2026-11-25T08:00:00.000Z","updatedAt":"2026-11-25T09:00:00.000Z","progress":null,"progressAt":null,"runCount":1,"spentMicros":3000,"budgetMicros":300000,"title":"发票","runs":[],"exchanges":[],"tasks":[]}
      ]}
    ]}}}
    """

    @Test func readsTheSnapshotThroughTheThreadGateway() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(Self.snapshot.utf8))])
        let work = try await api(exchange).backgroundWork()
        let request = try #require(exchange.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path.hasSuffix("/gateway") == true)
        let httpBody = try #require(request.httpBody)
        let sent = try #require(try JSONSerialization.jsonObject(with: httpBody) as? [String: Any])
        #expect(Set(sent.keys) == ["gateway", "type", "messageId", "payload"])
        #expect(sent["gateway"] as? String == "thread-v3")
        #expect(sent["type"] as? String == "thread.background_work")
        #expect(work.matters.count == 2)
        let trip = work.matters[0]
        #expect(trip.spentMicros == 570_000)
        #expect(trip.subthreads[0].title == "订机票")
        #expect(trip.subthreads[0].tasks.count == 3)
        #expect(trip.subthreads[0].exchanges[1].kind == .resultBoard)
    }

    @Test func entryCountsOpenMattersAndOverBudgetSubthreads() throws {
        let work = try decoded()
        #expect(work.showsEntry)
        #expect(work.openMatterCount == 1)
        #expect(work.overBudgetCount == 1)
        let quiet = BackgroundWork(matters: [work.matters[1]])
        #expect(!quiet.showsEntry)
        #expect(quiet.openMatterCount == 0)
        #expect(BackgroundWork(matters: []).showsEntry == false)
    }

    @Test func finishedMattersStayOnlyOnTheDayTheyFinished() throws {
        let work = try decoded()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let sameDay = try #require(ISO8601DateFormatter().date(from: "2026-11-25T20:00:00Z"))
        let nextDay = try #require(ISO8601DateFormatter().date(from: "2026-11-26T01:00:00Z"))
        #expect(work.visibleMatters(now: sameDay, calendar: calendar).map(\.matter) == ["12 月 3 日大阪出差", "整理发票"])
        #expect(work.visibleMatters(now: nextDay, calendar: calendar).map(\.matter) == ["12 月 3 日大阪出差"])
    }

    @Test func subthreadRowShowsTheActiveTaskAndStepOnlyWhenThereAreTasks() throws {
        let work = try decoded()
        let flights = work.matters[0].subthreads[0]
        #expect(flights.currentDoing == "正在比三班的价格")
        #expect(flights.step?.current == 2)
        #expect(flights.step?.total == 3)
        #expect(flights.tag == .working)
        let over = work.matters[0].subthreads[1]
        #expect(over.step == nil)
        #expect(over.currentDoing == nil)
        #expect(over.tag == .overBudget)
        #expect(over.nearBudget)
        #expect(!flights.nearBudget)
        #expect(work.matters[1].subthreads[0].tag == .done)
        #expect(flights.runsNewestFirst.map(\.runId) == ["run-2", "run-1"])
    }

    @Test func tagsFollowStatusBeforeActivity() {
        let now = Date()
        func sub(_ status: BackgroundWork.Subthread.Status, _ activity: BackgroundWork.Subthread.Activity) -> BackgroundWork.Subthread {
            BackgroundWork.Subthread(subthreadId: "s", status: status, activity: activity, openedAt: now, updatedAt: now, budgetMicros: 1)
        }
        #expect(sub(.stopped, .running).tag == .stopped)
        #expect(sub(.returned, .idle).tag == .done)
        #expect(sub(.open, .queued).tag == .working)
        #expect(sub(.open, .waitingAnswer).tag == .waitingAnswer)
        #expect(sub(.open, .waitingResult).tag == .waitingResult)
        #expect(sub(.open, .idle).tag == nil)
    }

    @Test func progressIsUsedWhenNoTaskIsInProgress() {
        let now = Date()
        let sub = BackgroundWork.Subthread(subthreadId: "s", status: .open, activity: .running, openedAt: now, updatedAt: now, progress: "  查好了  ", budgetMicros: 1, tasks: [.init(number: 1, status: .completed, subject: "查")])
        #expect(sub.currentDoing == "查好了")
        #expect(sub.step?.current == 1)
        #expect(sub.step?.total == 1)
    }

    @Test func moneyIsMicroDollarsToTwoDecimals() {
        #expect(MicroDollars.dollars(500_000) == "0.50")
        #expect(MicroDollars.dollars(120_000) == "0.12")
        #expect(MicroDollars.dollars(1_234_567) == "1.23")
        #expect(MicroDollars.dollars(10_000) == "0.01")
        #expect(MicroDollars.dollars(9_999) == nil)
        #expect(MicroDollars.dollars(0) == nil)
    }

    private func decoded() throws -> BackgroundWork {
        struct Snapshot: Decodable { let work: BackgroundWork }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom(DeviceAPI.timestamp)
        return try decoder.decode(GatewayEnvelope<Snapshot>.self, from: Data(Self.snapshot.utf8)).payload.work
    }
}
