import Foundation
import XCTest
@testable import HimawariManage

private actor VersionServer: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        await record(body)
        switch body["type"] {
        case .string("memory.overview.read"):
            return DeviceResponse(status: 200, body: Data(Self.overview.utf8))
        case .string("memory.rules.read"):
            return DeviceResponse(status: 200, body: Data(#"{"payload":{"rules":[]}}"#.utf8))
        default:
            return DeviceResponse(status: 200, body: Data("{}".utf8))
        }
    }

    private func record(_ body: [String: JSONValue]) {
        sent.append(body)
    }

    static let overview = #"""
    {"payload":{"memories":[
      {"memoryId":"m1","revision":3,"text":"坐新干线喜欢靠窗","inference":false,"sourceThreadId":null,"sourceRefs":[],"category":"other","subCategory":null,"status":"active","recordedAt":"2026-10-30T03:00:00.000Z","updatedAt":"2026-10-30T03:00:00.000Z","lastUsedAt":null,"importBatchId":null,"history":[
        {"historyId":1,"kind":"created","text":"坐新干线喜欢靠过道","quote":null,"sourceThreadId":null,"sourceDeleted":false,"at":"2026-09-01T03:00:00.000Z"},
        {"historyId":2,"kind":"edited","text":"坐新干线随便","quote":null,"sourceThreadId":null,"sourceDeleted":false,"at":"2026-10-01T03:00:00.000Z"},
        {"historyId":3,"kind":"reaffirmed","text":"坐新干线随便","quote":null,"sourceThreadId":null,"sourceDeleted":false,"at":"2026-10-10T03:00:00.000Z"},
        {"historyId":4,"kind":"updated","text":"坐新干线喜欢靠窗","quote":null,"sourceThreadId":null,"sourceDeleted":false,"at":"2026-10-30T03:00:00.000Z"}
      ]},
      {"memoryId":"m2","revision":2,"text":"周三早上去健身房","inference":true,"sourceThreadId":null,"sourceRefs":[],"category":"other","subCategory":null,"status":"trashed","recordedAt":"2026-10-02T03:00:00.000Z","updatedAt":"2026-11-24T03:00:00.000Z","lastUsedAt":null,"importBatchId":null,"history":[]}
    ],"imports":[],"capturePaused":false}}
    """#
}

@MainActor
final class MemoryVersionsTrashTests: XCTestCase {
    private func loaded(_ server: VersionServer) async -> MemoryStore {
        let store = MemoryStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
        await store.load()
        return store
    }

    func testEarlierVersionsAreNewestFirstWithoutTheCurrentWordingOrReaffirmations() async throws {
        let store = await loaded(VersionServer())
        let item = try XCTUnwrap(store.overview?.memories.first { $0.memoryId == "m1" })
        XCTAssertEqual(MemoryStore.previousVersions(of: item).map(\.historyId), [2, 1])
    }

    func testATrashedMemoryHasNoVersionsToRestoreButShowsInTheTrash() async throws {
        let store = await loaded(VersionServer())
        let trashed = try XCTUnwrap(store.trashed.first)
        XCTAssertEqual(store.trashed.map(\.memoryId), ["m2"])
        XCTAssertEqual(MemoryStore.previousVersions(of: trashed).count, 0)
        XCTAssertFalse(store.groups(categoryLabel: { $0 }).flatMap(\.items).contains { $0.memoryId == "m2" })
    }

    func testTheTrashDeadlineFollowsTheContractRetention() async throws {
        let store = await loaded(VersionServer())
        let trashed = try XCTUnwrap(store.trashed.first)
        let deadline = try XCTUnwrap(MemoryStore.trashDeadline(of: trashed))
        let trashedAt = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-24T03:00:00Z"))
        XCTAssertEqual(deadline.timeIntervalSince(trashedAt), TimeInterval(ClientCapabilities.memoryTrashDays) * 86_400)
        let line = try XCTUnwrap(TrashRow.line(trashed, now: trashedAt.addingTimeInterval(86_400)))
        XCTAssertTrue(line.contains("\(ClientCapabilities.memoryTrashDays - 1)"))
    }

    func testUsingAnEarlierVersionSendsRestoreVersionWithItsHistoryId() async throws {
        let server = VersionServer()
        let store = await loaded(server)
        let item = try XCTUnwrap(store.overview?.memories.first { $0.memoryId == "m1" })
        try await store.restoreVersion(item, historyId: 2, reason: "r")
        let sent = await server.sent
        let command = try XCTUnwrap(sent.first { $0["type"] == .string("memory.mutate") })
        XCTAssertEqual(command["payload"], .object([
            "action": .string("restore_version"),
            "memoryId": .string("m1"),
            "expectedRevision": .number(3),
            "contentRef": .null,
            "historyId": .number(2),
        ]))
    }

    func testRestoringFromTheTrashSendsRecover() async throws {
        let server = VersionServer()
        let store = await loaded(server)
        let trashed = try XCTUnwrap(store.trashed.first)
        try await store.recover(trashed, reason: "r")
        let sent = await server.sent
        let command = try XCTUnwrap(sent.first { $0["type"] == .string("memory.mutate") })
        XCTAssertEqual(command["payload"], .object([
            "action": .string("recover"),
            "memoryId": .string("m2"),
            "expectedRevision": .number(2),
            "contentRef": .null,
            "historyId": .null,
        ]))
    }
}
