import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

final class RecordedReadProblems: ReadProblemTransport, @unchecked Sendable {
    struct Report: Equatable {
        let source: String
        let code: String
        let failures: Int
        let sinceSeconds: Int
    }

    private let lock = NSLock()
    private var stored: [Report] = []
    var fails = false

    var reports: [Report] { lock.withLock { stored } }

    func reportReadProblem(source: String, code: String, failures: Int, sinceSeconds: Int) async throws {
        if lock.withLock({ fails }) { throw DeviceAPIError.invalidResponse }
        lock.withLock { stored.append(Report(source: source, code: code, failures: failures, sinceSeconds: sinceSeconds)) }
    }
}

@Suite struct ReadProblemsTests {
    private let moment = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func retriesWaitLongerEachTimeUpToFifteenMinutes() {
        #expect(ReadRetry.delay(afterFailures: 1) == 30)
        #expect(ReadRetry.delay(afterFailures: 2) == 60)
        #expect(ReadRetry.delay(afterFailures: 3) == 120)
        #expect(ReadRetry.delay(afterFailures: 6) == 900)
        #expect(ReadRetry.delay(afterFailures: 40) == 900)
    }

    @Test func aReadThatKeepsFailingIsReportedOnceAnHourAndASuccessClearsIt() async {
        let transport = RecordedReadProblems()
        let clock = Clock(moment)
        let problems = ReadProblems(transport: transport, now: { clock.now })
        await problems.failed(.health, code: "HEALTH_5")
        clock.now = moment.addingTimeInterval(30)
        await problems.failed(.health, code: "HEALTH_5")
        #expect(transport.reports.isEmpty)
        clock.now = moment.addingTimeInterval(90)
        #expect(await problems.failed(.health, code: "HEALTH_5") == 3)
        #expect(transport.reports == [RecordedReadProblems.Report(source: "health", code: "HEALTH_5", failures: 3, sinceSeconds: 90)])
        clock.now = moment.addingTimeInterval(600)
        await problems.failed(.health, code: "HEALTH_5")
        #expect(transport.reports.count == 1)
        clock.now = moment.addingTimeInterval(90 + 3600)
        await problems.failed(.health, code: "HEALTH_5")
        #expect(transport.reports.count == 2)
        await problems.succeeded(.health)
        #expect(await problems.failures(.health) == 0)
        await problems.failed(.health, code: "HEALTH_5")
        #expect(transport.reports.count == 2)
    }

    @Test func aReportThatCouldNotBeSentIsTriedAgainOnTheNextFailure() async {
        let transport = RecordedReadProblems()
        transport.fails = true
        let problems = ReadProblems(transport: transport, now: { self.moment })
        for _ in 0..<3 { await problems.failed(.perceptionUpload, code: "HTTP_503") }
        #expect(transport.reports.isEmpty)
        transport.fails = false
        await problems.failed(.perceptionUpload, code: "HTTP_503")
        #expect(transport.reports.map(\.failures) == [4])
    }

    @Test func eachSourceIsCountedOnItsOwn() async {
        let transport = RecordedReadProblems()
        let problems = ReadProblems(transport: transport, now: { self.moment })
        await problems.failed(.contacts, code: "CONTACTS_1")
        await problems.failed(.mirrorUpload, code: "HTTP_500")
        await problems.failed(.contacts, code: "CONTACTS_1")
        #expect(await problems.failures(.contacts) == 2)
        #expect(await problems.failures(.mirrorUpload) == 1)
        #expect(transport.reports.isEmpty)
    }

    @Test func errorsBecomeStableCodes() {
        #expect(ReadRetry.code(DeviceAPIError.server(status: 503, code: nil)) == "HTTP_503")
        #expect(ReadRetry.code(DeviceAPIError.server(status: 429, code: "DEVICE_RATE_LIMITED")) == "DEVICE_RATE_LIMITED")
        #expect(ReadRetry.code(DeviceAPIError.invalidResponse) == "INVALID_RESPONSE")
        #expect(ReadRetry.code(URLError(.notConnectedToInternet)) == "NETWORK_1009")
    }

    @Test func theDeviceSendsTheReportSignedToTheServer() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(#"{"accepted":true}"#.utf8))])
        let http = DeviceHTTPClient(exchange: exchange, now: { self.moment })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test:8443/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        try await DeviceAPI(http: http).reportReadProblem(source: "health", code: "HEALTH_5", failures: 3, sinceSeconds: 90)
        let request = try #require(exchange.requests.first)
        #expect(request.url?.path == "/api/device/v1/read-problems")
        let body = try #require(JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: Any])
        #expect(body["source"] as? String == "health")
        #expect(body["code"] as? String == "HEALTH_5")
        #expect(body["failures"] as? Int == 3)
        #expect(body["sinceSeconds"] as? Int == 90)
    }
}
