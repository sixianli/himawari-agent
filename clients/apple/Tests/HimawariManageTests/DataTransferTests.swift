import Foundation
import XCTest
@testable import HimawariManage

private actor TransferServer: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private(set) var uploads: [String] = []
    private var statusReplies: [String]
    private let preview: String

    init(statusReplies: [String] = [], preview: String = "{}") {
        self.statusReplies = statusReplies
        self.preview = preview
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-26T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        if path == ManageGateway.textPath {
            if case .string(let content)? = body["content"] { await upload(content) }
            let count = await uploads.count
            return DeviceResponse(status: 200, body: Data(#"{"payloadRef":"upload-\#(count)"}"#.utf8))
        }
        await record(body)
        switch body["type"] {
        case .string("data.export.start"):
            return DeviceResponse(status: 200, body: Data(#"{"resultRef":"data-export:abcdefghijklmnopqrstuv","replayed":false}"#.utf8))
        case .string("data.export.status.read"):
            return DeviceResponse(status: 200, body: Data(await nextStatus().utf8))
        case .string("memory.import.preview.read"):
            return DeviceResponse(status: 200, body: Data(preview.utf8))
        default:
            return DeviceResponse(status: 200, body: Data(#"{"resultRef":"ok","replayed":false}"#.utf8))
        }
    }

    private func record(_ body: [String: JSONValue]) { sent.append(body) }
    private func upload(_ content: String) { uploads.append(content) }
    private func nextStatus() -> String { statusReplies.isEmpty ? "{}" : statusReplies.removeFirst() }
}

private func status(_ state: String, result: String = "null", progress: String = "null", failure: String = "null") -> String {
    #"{"payload":{"exportId":"data-export:abcdefghijklmnopqrstuv","state":"\#(state)","startedAt":null,"finishedAt":null,"failureCode":\#(failure),"progress":\#(progress),"result":\#(result),"generatedAt":"2026-11-26T00:00:00.000Z"}}"#
}

private let archive = Data("zip-bytes".utf8)
private let archiveSha = DataExportStore.hex(Data("zip-bytes".utf8))

private func ready(size: Int = 9, sha: String = archiveSha) -> String {
    status("ready", result: #"{"downloadPath":"/api/data-export/v1/archive?exportId=data-export:abcdefghijklmnopqrstuv","fileName":"himawari-export-2026-11-26.zip","sizeBytes":\#(size),"sha256":"\#(sha)","memories":12,"rules":3,"withheld":1,"expiresAt":"2026-11-26T00:10:00.000Z"}"#)
}

@MainActor
final class DataTransferTests: XCTestCase {
    func testExportStartsWithFaceIdWaitsUntilReadyAndDownloadsTheCheckedArchive() async {
        let server = TransferServer(statusReplies: [
            status("running", progress: #"{"textsRead":3,"textsTotal":10}"#),
            ready(),
        ])
        let store = DataExportStore(
            gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }),
            download: { id in
                XCTAssertEqual(id, "data-export:abcdefghijklmnopqrstuv")
                return archive
            },
            wait: {}
        )
        await store.start(reason: "导出")
        XCTAssertEqual(
            store.phase,
            .ready(ExportedArchive(fileName: "himawari-export-2026-11-26.zip", data: archive, memories: 12, rules: 3, withheld: 1))
        )
        let types = await server.sent.compactMap { body -> String? in
            if case .string(let type)? = body["type"] { return type }
            return nil
        }
        XCTAssertEqual(types, ["data.export.start", "data.export.status.read", "data.export.status.read"])
    }

    func testExportRefusesAnArchiveThatDoesNotMatchTheServersChecksum() async {
        let server = TransferServer(statusReplies: [ready(sha: String(repeating: "0", count: 64))])
        let store = DataExportStore(
            gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }),
            download: { _ in archive },
            wait: {}
        )
        await store.start(reason: "导出")
        XCTAssertEqual(store.phase, .failed("DATA_EXPORT_DOWNLOAD_DAMAGED"))
    }

    func testExportReportsTheServersFailure() async {
        let server = TransferServer(statusReplies: [status("failed", failure: #""DATA_EXPORT_TOO_LARGE""#)])
        let store = DataExportStore(
            gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }),
            download: { _ in XCTFail("no download"); return Data() },
            wait: {}
        )
        await store.start(reason: "导出")
        XCTAssertEqual(store.phase, .failed("DATA_EXPORT_TOO_LARGE"))
    }

    private static let preview = #"{"payload":{"files":[{"name":"MEMORY.md","state":"read","found":3}],"found":3,"items":[{"contentRef":"memory-import:private:a","text":"每天早上跑步","from":"MEMORY.md","category":"preference","subCategory":null,"topic":null,"flag":null,"selectable":true,"checked":true},{"contentRef":"memory-import:private:b","text":"住在东京","from":"MEMORY.md","category":"identity","subCategory":null,"topic":null,"flag":"duplicate","selectable":false,"checked":false},{"contentRef":"memory-import:sensitive:c","text":"在吃降压药","from":"MEMORY.md","category":"health","subCategory":null,"topic":"health","flag":"unchecked","selectable":true,"checked":false}]}}"#

    func testImportUploadsEachFileAsksForAPreviewAndImportsOnlyTheTickedEntries() async {
        let server = TransferServer(preview: Self.preview)
        let store = MemoryImportStore(
            gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }),
            makeBatchId: { "memory-import-test" }
        )
        await store.preview(.codex, files: [MemoryImportFile(name: "MEMORY.md", text: "# User Profile\n每天早上跑步")])
        XCTAssertEqual(store.phase, .preview)
        XCTAssertEqual(store.found, 3)
        XCTAssertEqual(store.chosen.map(\.text), ["每天早上跑步"])
        let uploads = await server.uploads
        XCTAssertEqual(uploads, ["# User Profile\n每天早上跑步"])
        let request = await server.sent.first { $0["type"] == .string("memory.import.preview.read") }
        XCTAssertEqual(
            request?["payload"],
            .object(["source": .string("codex"), "files": .array([.object(["name": .string("MEMORY.md"), "contentRef": .string("upload-1")])])])
        )

        store.toggle(store.items[1])
        XCTAssertEqual(store.chosen.count, 1)
        store.toggle(store.items[2])
        XCTAssertEqual(store.chosen.map(\.text), ["每天早上跑步", "在吃降压药"])

        let committed = await store.commit(reason: "导入 2 条记忆")
        XCTAssertTrue(committed)
        XCTAssertEqual(store.phase, .done(2))
        let commit = await server.sent.first { $0["type"] == .string("memory.import.commit") }
        XCTAssertEqual(
            commit?["payload"],
            .object([
                "batchId": .string("memory-import-test"),
                "source": .string("codex"),
                "items": .array([
                    .object(["contentRef": .string("memory-import:private:a"), "category": .string("preference"), "subCategory": .null, "topic": .null]),
                    .object(["contentRef": .string("memory-import:sensitive:c"), "category": .string("health"), "subCategory": .null, "topic": .string("health")]),
                ]),
            ])
        )
    }

    func testImportStopsBeforeUploadingWhenAFileIsTooLongOrThereAreTooManyFiles() async {
        let server = TransferServer(preview: Self.preview)
        let store = MemoryImportStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
        let long = String(repeating: "a", count: ClientCapabilities.textUploadMaximumCharacters + 1)
        await store.preview(.codex, files: [MemoryImportFile(name: "big.md", text: long)])
        XCTAssertEqual(store.phase, .problem(.tooLong(name: "big.md", maximum: ClientCapabilities.textUploadMaximumCharacters)))
        let many = (0...ClientCapabilities.memoryImportFilesMaximum).map { MemoryImportFile(name: "\($0).md", text: "x") }
        await store.preview(.codex, files: many)
        XCTAssertEqual(store.phase, .problem(.tooManyFiles(ClientCapabilities.memoryImportFilesMaximum)))
        let uploads = await server.uploads
        XCTAssertEqual(uploads, [])
    }

    func testImportSaysTheFileWasUnreadableWhenTheServerCouldNotReadAnyFile() async {
        let server = TransferServer(preview: #"{"payload":{"files":[{"name":"old.json","state":"unreadable","found":0}],"found":0,"items":[]}}"#)
        let store = MemoryImportStore(gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }))
        await store.preview(.himawari, files: [MemoryImportFile(name: "old.json", text: "not json")])
        XCTAssertEqual(store.phase, .problem(.unreadable))
    }

    func testServerStatusShowsOnlyRowsTheServerReportedEachWithADefinition() throws {
        let full = try JSONDecoder().decode(
            ServerStatus.self,
            from: Data(#"{"live":true,"ready":false,"status":"degraded","dependencies":[{"name":"worker","required":true,"status":"blocked","reasonCode":"WORKER_STARTING"}],"release":{"commit":"25bf7041abc","installedAt":"2026-11-26T07:40:00.000Z"},"disk":{"availableBytes":21474836480,"totalBytes":50000000000},"generatedAt":"2026-11-26T08:00:00.000Z"}"#.utf8)
        )
        let rows = ServerStatusPage.rows(full)
        XCTAssertEqual(rows.map(\.title), [M.statusOverall, M.statusWorker, M.statusVersion, M.statusDeployed, M.statusDisk])
        XCTAssertTrue(rows.allSatisfy { !$0.definition.isEmpty })
        XCTAssertEqual(rows[2].value, "25bf704")
        XCTAssertEqual(rows[1].tone, .attention)

        let bare = try JSONDecoder().decode(
            ServerStatus.self,
            from: Data(#"{"live":true,"ready":true,"status":"healthy","dependencies":[],"release":null,"disk":null,"generatedAt":"2026-11-26T08:00:00.000Z"}"#.utf8)
        )
        XCTAssertEqual(ServerStatusPage.rows(bare).map(\.title), [M.statusOverall])
    }
}
