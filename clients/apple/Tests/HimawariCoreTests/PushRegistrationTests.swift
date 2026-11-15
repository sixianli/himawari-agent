import Foundation
import Testing

@testable import HimawariCore

final class FakePushTransport: PushRegistrationTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var outcomes: [Bool]
    private(set) var sent: [PushRegistrationRequest] = []

    init(_ outcomes: [Bool] = []) { self.outcomes = outcomes }

    func registerPush(_ request: PushRegistrationRequest) async throws -> Bool {
        lock.withLock {
            sent.append(request)
            return outcomes.isEmpty ? true : outcomes.removeFirst()
        }
    }
}

@Suite struct PushRegistrationTests {
    func sync(_ transport: FakePushTransport, languages: [String] = ["ja-JP"]) -> PushTokenSync {
        PushTokenSync(transport: transport, context: PushRegistrationContext(environment: "development", topic: "win.siyi.himawari", preferredLanguages: { languages }))
    }

    @Test func aTokenBecomesLowercaseHexAndAnEmptyOrHugeOneIsRefused() {
        #expect(PushRegistrationValues.tokenText(Data([0x00, 0xAB, 0x0F])) == "00ab0f")
        #expect(PushRegistrationValues.tokenText(Data()) == nil)
        #expect(PushRegistrationValues.tokenText(Data(repeating: 1, count: 257)) == nil)
        #expect(PushRegistrationValues.tokenText(Data(repeating: 1, count: 256))?.count == 512)
    }

    @Test func theLanguageMapsToTheThreeLanguagesTheServerKnows() {
        #expect(PushRegistrationValues.locale(preferred: ["ja-JP", "en"]) == "ja")
        #expect(PushRegistrationValues.locale(preferred: ["zh-Hans-CN"]) == "zh-CN")
        #expect(PushRegistrationValues.locale(preferred: ["fr-FR"]) == "en")
        #expect(PushRegistrationValues.locale(preferred: []) == "en")
    }

    @Test func aDebugBuildRegistersInTheDevelopmentEnvironmentAndAReleaseBuildInProduction() {
        #expect(PushRegistrationValues.environment(debugBuild: true) == "development")
        #expect(PushRegistrationValues.environment(debugBuild: false) == "production")
    }

    @Test func nothingIsSentUntilTheDeviceIsPairedAndATokenHasArrived() async {
        let transport = FakePushTransport()
        let sync = sync(transport)
        await sync.tokenArrived(Data([1, 2]))
        #expect(transport.sent.isEmpty)
        await sync.deviceReady()
        #expect(transport.sent.count == 1)
        #expect(transport.sent[0] == PushRegistrationRequest(token: "0102", environment: "development", topic: "win.siyi.himawari", locale: "ja"))
    }

    @Test func withoutATokenNothingIsSentEvenWhenReady() async {
        let transport = FakePushTransport()
        let sync = sync(transport)
        await sync.deviceReady()
        #expect(transport.sent.isEmpty)
    }

    @Test func theSameTokenIsOnlySentOnceAndANewOneIsSentAgain() async {
        let transport = FakePushTransport()
        let sync = sync(transport)
        await sync.deviceReady()
        await sync.tokenArrived(Data([1]))
        await sync.tokenArrived(Data([1]))
        await sync.deviceReady()
        #expect(transport.sent.count == 1)
        await sync.tokenArrived(Data([2]))
        #expect(transport.sent.map(\.token) == ["01", "02"])
    }

    @Test func aRefusedRegistrationIsTriedAgainTheNextTimeTheDeviceIsReady() async {
        let transport = FakePushTransport([false, true])
        let sync = sync(transport)
        await sync.tokenArrived(Data([1]))
        await sync.deviceReady()
        await sync.deviceReady()
        await sync.deviceReady()
        #expect(transport.sent.count == 2)
    }

    @Test func aRemovedDeviceSendsNothingAndRegistersAgainWhenPairedAgain() async {
        let transport = FakePushTransport()
        let sync = sync(transport)
        await sync.tokenArrived(Data([1]))
        await sync.deviceReady()
        await sync.deviceGone()
        await sync.tokenArrived(Data([1]))
        #expect(transport.sent.count == 1)
        await sync.deviceReady()
        #expect(transport.sent.count == 2)
    }

    @Test func registeringPostsTheTokenToThePushRoute() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 200, body: Data(#"{"registration":{}}"#.utf8))])
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        let ok = try await DeviceAPI(http: http).registerPush(PushRegistrationRequest(token: "ab", environment: "production", topic: "win.siyi.himawari", locale: "en"))
        #expect(ok)
        let request = try #require(exchange.requests.first)
        #expect(request.url?.path == "/api/device/v1/push/register")
        let data = try #require(request.httpBody)
        let body = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(body == ["pushType": "alert", "token": "ab", "environment": "production", "topic": "win.siyi.himawari", "locale": "en"])
    }

    @Test func aServerThatIsNotConfiguredForPushIsNotAnError() async throws {
        let exchange = RecordingExchange([HTTPExchangeResponse(status: 503, body: Data(#"{"error":{"code":"PUSH_NOT_CONFIGURED"}}"#.utf8))])
        let http = DeviceHTTPClient(exchange: exchange)
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        let ok = try await DeviceAPI(http: http).registerPush(PushRegistrationRequest(token: "ab", environment: "production", topic: "win.siyi.himawari", locale: "en"))
        #expect(!ok)
    }
}
