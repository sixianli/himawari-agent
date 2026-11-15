import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct ThreadManagementTests {
    private func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    private func json(_ request: URLRequest) throws -> [String: Any] {
        let data = try #require(request.httpBody)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func reply(_ text: String) -> HTTPExchangeResponse {
        HTTPExchangeResponse(status: 200, body: Data(text.utf8))
    }

    private let textCreated = #"{"payloadRef":"payload-ref-1"}"#
    private let accepted = #"{"type":"thread.command_result","payload":{"commandType":"thread.rename","commandId":"c","threadId":"t1","threadRevision":4,"resultRef":"r","replayed":false,"committedAt":"2026-11-15T00:00:00Z"}}"#

    @Test func renameProtectsTheTitleThenSendsAThreadV3CommandWithTheRefs() async throws {
        let exchange = RecordingExchange([reply(#"{"payloadRef":"title-ref"}"#), reply(#"{"payloadRef":"result-ref"}"#), reply(accepted)])
        let outcome = try await api(exchange).renameThread("t1", expectedRevision: 3, title: "大阪行程")
        #expect(outcome == .accepted(threadRevision: 4, replayed: false))
        #expect(exchange.requests.count == 3)
        let titleBody = try json(exchange.requests[0])
        #expect(titleBody["content"] as? String == "大阪行程")
        #expect(titleBody["dataClassification"] as? String == "private")
        #expect(exchange.requests[0].url?.path.hasSuffix("/payloads/text/new") == true)
        let command = try json(exchange.requests[2])
        #expect(exchange.requests[2].url?.path.hasSuffix("/gateway") == true)
        #expect(Set(command.keys) == ["gateway", "type", "messageId", "idempotencyKey", "payload"])
        #expect(command["gateway"] as? String == "thread-v3")
        #expect(command["type"] as? String == "thread.rename")
        let payload = try #require(command["payload"] as? [String: Any])
        #expect(payload["titleRef"] as? String == "title-ref")
        #expect(payload["resultRef"] as? String == "result-ref")
        #expect(payload["titleSource"] as? String == "owner")
        #expect(payload["expectedRevision"] as? Int == 3)
    }

    @Test func unpinSendsAnExplicitNullPinOrder() async throws {
        let exchange = RecordingExchange([reply(textCreated), reply(accepted)])
        _ = try await api(exchange).pinThread("t1", expectedRevision: 2, pinOrder: nil)
        let command = try json(exchange.requests[1])
        let payload = try #require(command["payload"] as? [String: Any])
        #expect(payload["pinOrder"] is NSNull)
        #expect(command["type"] as? String == "thread.pin")
    }

    @Test func pinSendsTheOrder() async throws {
        let exchange = RecordingExchange([reply(textCreated), reply(accepted)])
        _ = try await api(exchange).pinThread("t1", expectedRevision: 2, pinOrder: 0)
        let payload = try #require(try json(exchange.requests[1])["payload"] as? [String: Any])
        #expect(payload["pinOrder"] as? Int == 0)
    }

    @Test(arguments: [ThreadGatewayCommand.archive, ThreadGatewayCommand.restore, ThreadGatewayCommand.trash])
    func lifecycleCommandsCarryTheirTypeAndTheOwnerReason(type: String) async throws {
        let exchange = RecordingExchange([reply(textCreated), reply(accepted)])
        _ = try await api(exchange).lifecycleThread(type, threadId: "t1", expectedRevision: 5)
        let command = try json(exchange.requests[1])
        #expect(command["type"] as? String == type)
        let payload = try #require(command["payload"] as? [String: Any])
        #expect(Set(payload.keys) == ["threadId", "expectedRevision", "reasonCode", "resultRef"])
        #expect(payload["reasonCode"] as? String == "owner_requested")
    }

    @Test func aConflictAnswerIsReturnedAsAConflictWithTheLatestThread() async throws {
        let conflict = #"{"type":"thread.conflict","payload":{"commandType":"thread.archive","threadId":"t1","reasonCode":"PORT_CONFLICT","latest":null,"generatedAt":"2026-11-15T00:00:00Z"}}"#
        let exchange = RecordingExchange([reply(textCreated), reply(conflict)])
        let outcome = try await api(exchange).lifecycleThread(ThreadGatewayCommand.archive, threadId: "t1", expectedRevision: 1)
        #expect(outcome == .conflict(reasonCode: "PORT_CONFLICT", latest: nil))
    }

    @Test func forkNamesAFreshTargetAndReturnsIt() async throws {
        let exchange = RecordingExchange([reply(textCreated), reply(accepted)])
        let created = try await api(exchange).forkThread(from: "t1", turnId: "turn-9", watermark: 12)
        let payload = try #require(try json(exchange.requests[1])["payload"] as? [String: Any])
        #expect(payload["sourceThreadId"] as? String == "t1")
        #expect(payload["sourceTurnId"] as? String == "turn-9")
        #expect(payload["sourceWatermark"] as? Int == 12)
        #expect(payload["targetThreadId"] as? String == created.threadId)
        #expect(created.threadId.hasPrefix("thread-fork:"))
        #expect(payload["summaryRefs"] as? [String] == [])
    }

    @Test func answerLocaleUsesTheServerSpelling() async throws {
        let exchange = RecordingExchange([reply(textCreated), reply(accepted)])
        _ = try await api(exchange).setThreadAnswerLocale("t1", expectedRevision: 2, locale: .japanese)
        let payload = try #require(try json(exchange.requests[1])["payload"] as? [String: Any])
        #expect(payload["answerLocale"] as? String == "ja")
    }

    @Test func listingArchivedThreadsAsksOnlyForArchivedAndFollowsCursors() async throws {
        func page(_ id: String, next: String?) -> String {
            let cursor = next.map { "\"\($0)\"" } ?? "null"
            return #"{"type":"thread.collection_snapshot","payload":{"threads":[{"threadId":"\#(id)","revision":2,"status":"archived","titleRef":null,"pinOrder":null,"answerLocale":"zh-CN","messageWatermark":1,"createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-02T00:00:00Z"}],"nextCursor":\#(cursor),"snapshotRef":"s","generatedAt":"2026-11-15T00:00:00Z"}}"#
        }
        let exchange = RecordingExchange([reply(page("a", next: "c1")), reply(page("b", next: nil))])
        let threads = try await api(exchange).allThreads(statuses: [.archived])
        #expect(threads.map(\.threadId) == ["a", "b"])
        let first = try #require(try json(exchange.requests[0])["payload"] as? [String: Any])
        #expect(first["statuses"] as? [String] == ["archived"])
        #expect(first["afterCursor"] is NSNull)
        let second = try #require(try json(exchange.requests[1])["payload"] as? [String: Any])
        #expect(second["afterCursor"] as? String == "c1")
        #expect(try json(exchange.requests[0])["idempotencyKey"] == nil)
    }

    @Test func aRepeatedCursorStopsTheListing() async throws {
        let body = #"{"type":"thread.collection_snapshot","payload":{"threads":[],"nextCursor":"same","snapshotRef":"s","generatedAt":"2026-11-15T00:00:00Z"}}"#
        let exchange = RecordingExchange([reply(body), reply(body)])
        await #expect(throws: DeviceAPIError.self) {
            _ = try await api(exchange).allThreads(statuses: [.archived])
        }
    }

    @Test func deletionImpactCountsOnlyActiveTasksAndKeepsTheServerVerdict() async throws {
        let body = #"{"type":"thread.deletion_impact_snapshot","payload":{"threadId":"t1","threadRevision":6,"associatedTasks":[{"taskId":"k1","revision":2,"threadId":"t1","status":"active"},{"taskId":"k2","revision":1,"threadId":"t1","status":"paused"}],"activeTaskIds":["k1"],"deletionAllowed":false,"snapshotRef":"s","generatedAt":"2026-11-15T00:00:00Z"}}"#
        let exchange = RecordingExchange([reply(body)])
        let impact = try await api(exchange).deletionImpact(threadId: "t1")
        #expect(impact.activeTasks.map(\.taskId) == ["k1"])
        #expect(impact.tasks.count == 2)
        #expect(impact.deletionAllowed == false)
        #expect(impact.threadRevision == 6)
    }

    @Test func pausingATaskSendsItsRevisionAndNoTargetThread() async throws {
        let exchange = RecordingExchange([reply(textCreated), reply(accepted)])
        _ = try await api(exchange).pauseTask(ThreadTaskBinding(taskId: "k1", revision: 2, status: "active"), in: "t1")
        let command = try json(exchange.requests[1])
        #expect(command["type"] as? String == "thread.task.resolve")
        let payload = try #require(command["payload"] as? [String: Any])
        #expect(payload["action"] as? String == "pause")
        #expect(payload["expectedTaskRevision"] as? Int == 2)
        #expect(payload["targetThreadId"] is NSNull)
    }

    @Test func gatewayIdentifiersStartWithALetterOrDigitAndFitTheServerPattern() {
        for _ in 0..<50 {
            let id = DeviceAPI.gatewayIdentifier("device-")
            #expect(id.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) != nil)
        }
        let text = DeviceAPI.gatewayIdentifier("device-text-")
        #expect(text.range(of: "^[A-Za-z0-9_-]{16,64}$", options: .regularExpression) != nil)
    }

    private func message(_ id: String, _ sequence: Int, turn: String?, status: MessageStatus = .committed, role: String = "agent") throws -> ThreadMessage {
        let turnJSON = turn.map { "\"\($0)\"" } ?? "null"
        let text = #"{"messageId":"\#(id)","sequence":\#(sequence),"role":"\#(role)","contentRef":"c","status":"\#(status.rawValue)","turnId":\#(turnJSON),"runId":null,"committedAt":"2026-11-15T00:00:00Z"}"#
        return try JSONDecoder().decode(ThreadMessage.self, from: Data(text.utf8))
    }

    @Test func forkSourceIsTheNewestCommittedAgentMessageWithATurn() throws {
        let messages = [
            try message("m1", 1, turn: "turn-1"),
            try message("m2", 2, turn: "turn-1"),
            try message("m3", 3, turn: nil),
            try message("m4", 4, turn: "turn-2", status: .partial),
            try message("m5", 5, turn: "turn-3", role: "owner"),
        ]
        let source = try #require(ThreadForkSource.latest(in: messages))
        #expect(source.turnId == "turn-1")
        #expect(source.watermark == 2)
    }

    @Test func retryingAfterAnUnknownResultReusesTheSameIdentity() async throws {
        let exchange = RecordingExchange([
            reply(textCreated), HTTPExchangeResponse(status: 503, body: Data()),
            reply(textCreated), reply(accepted),
        ])
        let service = try api(exchange)
        await #expect(throws: (any Error).self) { _ = try await service.forkThread(from: "t1", turnId: "turn-9", watermark: 12) }
        let created = try await service.forkThread(from: "t1", turnId: "turn-9", watermark: 12)
        let first = try json(exchange.requests[1])
        let second = try json(exchange.requests[3])
        #expect(first["idempotencyKey"] as? String == second["idempotencyKey"] as? String)
        #expect(first["messageId"] as? String == second["messageId"] as? String)
        #expect((first["payload"] as? [String: Any])?["targetThreadId"] as? String == created.threadId)
        #expect((second["payload"] as? [String: Any])?["targetThreadId"] as? String == created.threadId)
    }

    @Test func aNewActionAfterAnAcceptedOneGetsANewIdentity() async throws {
        let exchange = RecordingExchange([reply(textCreated), reply(accepted), reply(textCreated), reply(accepted)])
        let service = try api(exchange)
        _ = try await service.pinThread("t1", expectedRevision: 3, pinOrder: 0)
        _ = try await service.pinThread("t1", expectedRevision: 3, pinOrder: 0)
        #expect(try json(exchange.requests[1])["idempotencyKey"] as? String != json(exchange.requests[3])["idempotencyKey"] as? String)
    }

    @Test func forkSourceIsAbsentWithoutAnyTurn() throws {
        #expect(ThreadForkSource.latest(in: []) == nil)
        #expect(ThreadForkSource.latest(in: [try message("m1", 1, turn: nil)]) == nil)
    }

    @Test func searchMatchesAnyFieldIgnoringCaseAndRejectsOthers() {
        #expect(ThreadSearch.matches("osaka", in: ["Osaka trip", nil]))
        #expect(ThreadSearch.matches("住宿", in: ["大阪", "订好了住宿"]))
        #expect(ThreadSearch.matches("  ", in: [nil]))
        #expect(!ThreadSearch.matches("东京", in: ["大阪", "订好了住宿"]))
        #expect(!ThreadSearch.matches("x", in: [nil, nil]))
    }
}
