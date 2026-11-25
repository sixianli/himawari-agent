import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

final class StalledOpenExchange: HTTPExchange, @unchecked Sendable {
    private let lock = NSLock()
    private var opens: [Date] = []
    private var gate: CheckedContinuation<Void, Never>?
    private var released = false
    private let firstOpenFails: Bool

    init(firstOpenFails: Bool) {
        self.firstOpenFails = firstOpenFails
    }

    var openTimes: [Date] { lock.withLock { opens } }

    func release() {
        let pending = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            released = true
            defer { gate = nil }
            return gate
        }
        pending?.resume()
    }

    func send(_ request: URLRequest) async throws -> HTTPExchangeResponse {
        throw HTTPExchangeError.streamingUnsupported
    }

    func stream(_ request: URLRequest) async throws -> (status: Int, chunks: AsyncThrowingStream<String, Error>) {
        let index = lock.withLock { () -> Int in
            opens.append(Date())
            return opens.count
        }
        if index == 1 {
            await withTaskCancellationHandler {
                await withCheckedContinuation { (wait: CheckedContinuation<Void, Never>) in
                    let open = lock.withLock { () -> Bool in
                        if released { return true }
                        gate = wait
                        return false
                    }
                    if open { wait.resume() }
                }
            } onCancel: {
                self.release()
            }
            if firstOpenFails { throw URLError(.networkConnectionLost) }
        }
        let body = #"{"error":{"code":"DEVICE_REVOKED"}}"#
        return (403, AsyncThrowingStream { continuation in
            continuation.yield(body)
            continuation.finish()
        })
    }
}

@Suite(.serialized) struct DeviceEventStreamReconnectTests {
    private func client(_ exchange: StalledOpenExchange) throws -> DeviceHTTPClient {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return http
    }

    private func waitForOpens(_ exchange: StalledOpenExchange, _ count: Int) async throws {
        for _ in 0..<200 where exchange.openTimes.count < count {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    @Test(.timeLimit(.minutes(1))) func restartingWhileTheOpenIsStuckOpensAFreshConnectionWithoutReportingADisconnect() async throws {
        let exchange = StalledOpenExchange(firstOpenFails: false)
        let stream = DeviceEventStream(http: try client(exchange), cursors: nil, heartbeat: { 30 })
        let events = stream.start()
        try await waitForOpens(exchange, 1)
        stream.restartConnection()
        var seen: [DeviceStreamEvent] = []
        for await event in events { seen.append(event) }
        #expect(seen == [.sessionInvalid])
        #expect(exchange.openTimes.count == 2)
    }

    @Test(.timeLimit(.minutes(1))) func askingToReconnectWhileAnOpenIsUnderwaySkipsTheBackoffWhenThatOpenFails() async throws {
        let exchange = StalledOpenExchange(firstOpenFails: true)
        let stream = DeviceEventStream(http: try client(exchange), cursors: nil, heartbeat: { 30 })
        let events = stream.start()
        try await waitForOpens(exchange, 1)
        stream.reconnectNow()
        let failedAt = Date()
        exchange.release()
        var seen: [DeviceStreamEvent] = []
        for await event in events { seen.append(event) }
        #expect(seen == [.disconnected, .sessionInvalid])
        let reopenedAt = try #require(exchange.openTimes.last)
        #expect(reopenedAt.timeIntervalSince(failedAt) < DeviceEventStream.backoff(failures: 1) / 2)
    }
}
