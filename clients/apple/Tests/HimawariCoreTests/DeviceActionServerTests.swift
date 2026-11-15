import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

private let controlURL = ProcessInfo.processInfo.environment["HIMAWARI_ACTION_CONTROL"]

final class ServerClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date()

    var now: Date { lock.withLock { value } }

    func set(_ text: String) {
        if let date = DeviceActionTime.parse(text) { lock.withLock { value = date } }
    }
}

struct AlwaysAllowed: DevicePermission {
    var id: String { "notes" }
    var name: LocalizedLine { ["zh-CN": "笔记", "en": "Notes", "ja": "メモ"] }
    var settingsPath: LocalizedLine { ["zh-CN": "设置", "en": "Settings", "ja": "設定"] }
    var purpose: LocalizedLine { name }
    func status() async -> DevicePermissionStatus { .authorized }
    func request() async -> DevicePermissionStatus { .authorized }
}

final class NoteFileActions: DeviceActionHandler, @unchecked Sendable {
    let names = ["test.note.append", "test.note.touch", "test.note.v2"]
    let permission: DevicePermission = AlwaysAllowed()
    let file: URL

    init(file: URL) {
        self.file = file
    }

    var lines: [String] {
        ((try? String(contentsOf: file, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }

    func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? {
        ["lines": .number(Double(lines.count))]
    }

    func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        let text = try delivery.args.string("text")
        let updated = (lines + [text]).joined(separator: "\n") + "\n"
        try updated.write(to: file, atomically: true, encoding: .utf8)
        return ["text": .string(text)]
    }

    func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading {
        let text = try delivery.args.string("text")
        let found: JSONObject = ["lines": .array(lines.map { .string($0) })]
        return lines.contains(text) ? .matches(found) : .differs(found)
    }
}

struct Control {
    let base: URL

    func call(_ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = body == nil ? "GET" : "POST"
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, _) = try await URLSession.shared.data(for: request)
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }
}

@Suite(.serialized, .enabled(if: controlURL != nil))
struct DeviceActionServerTests {
    struct Setup {
        let control: Control
        let clock: ServerClock
        let api: DeviceAPI
        let deviceId: String
        let notes: NoteFileActions
        let directory: URL
    }

    func setUp() async throws -> Setup {
        let base = try #require(controlURL.flatMap(URL.init(string:)))
        let control = Control(base: base)
        let deviceKey = try SoftwareKeySigner()
        let confirmKey = try SoftwareKeySigner()
        let paired = try await control.call("pair", [
            "devicePublicKey": try deviceKey.publicKeySPKI().base64EncodedString(),
            "confirmPublicKey": try confirmKey.publicKeySPKI().base64EncodedString(),
        ])
        let deviceId = try #require(paired["deviceId"] as? String)
        let originText = try #require(paired["origin"] as? String)
        let origin = try #require(URL(string: originText))
        let clock = ServerClock()
        let now = try await control.call("clock")["now"] as? String
        clock.set(try #require(now))
        let http = DeviceHTTPClient(now: { clock.now })
        http.use(DeviceCredentials(origin: origin, deviceId: deviceId, access: nil, deviceKey: deviceKey))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("himawari-actions-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return Setup(control: control, clock: clock, api: DeviceAPI(http: http), deviceId: deviceId, notes: NoteFileActions(file: directory.appendingPathComponent("notes.txt")), directory: directory)
    }

    func executor(_ setup: Setup, store: String = "store") throws -> (DeviceActionExecutor, DeviceActionJournal) {
        let journal = DeviceActionJournal(store: try FileLocalStore(directory: setup.directory.appendingPathComponent(store)))
        return (DeviceActionExecutor(transport: setup.api, journal: journal, handlers: [setup.notes], locale: .chinese, now: { setup.clock.now }), journal)
    }

    func ask(_ setup: Setup, _ text: String, call: String, runId: String? = nil) async throws -> [String: Any] {
        var body: [String: Any] = ["deviceId": setup.deviceId, "action": "test.note.append", "arguments": ["text": text], "toolCallId": call]
        if let runId { body["runId"] = runId }
        return try await setup.control.call("request", body)
    }

    func advance(_ setup: Setup, seconds: Int) async throws {
        let now = try await setup.control.call("advance", ["seconds": seconds])["now"] as? String
        setup.clock.set(try #require(now))
    }

    @Test func performsReadsBackAndReportsWithTheStateBefore() async throws {
        let setup = try await setUp()
        let (executor, _) = try executor(setup)
        await executor.run()
        let asked = try await ask(setup, "买牛奶", call: "call-a")
        #expect(asked["state"] as? String == "queued")
        let runId = try #require(asked["runId"] as? String)
        let steps = await executor.run()
        #expect(steps.contains { if case .reported(_, .succeeded, true) = $0 { true } else { false } })
        let again = try await ask(setup, "买牛奶", call: "call-a", runId: runId)
        #expect(again["state"] as? String == "succeeded")
        let evidence = try #require(again["evidence"] as? [String: Any])
        #expect((evidence["before"] as? [String: Any])?["lines"] as? Int == 0)
        #expect(((evidence["readBack"] as? [String: Any])?["lines"] as? [String]) == ["买牛奶"])
        #expect(setup.notes.lines == ["买牛奶"])
        #expect(await executor.run().isEmpty)
        #expect(setup.notes.lines == ["买牛奶"])
    }

    @Test func aLostReportIsOnlyReadBackNeverDoneTwice() async throws {
        let setup = try await setUp()
        let (executor, journal) = try executor(setup)
        await executor.run()
        let asked = try await ask(setup, "交水费", call: "call-b")
        let runId = try #require(asked["runId"] as? String)
        let claimed = try await setup.api.claimActions()
        let delivery = try #require(claimed.first)
        let made = try await setup.notes.perform(delivery)
        try journal.update {
            $0.entries[delivery.id] = DeviceActionJournalEntry(id: delivery.id, action: delivery.action, stage: .started, before: nil, made: made, report: nil, updatedAt: setup.clock.now)
        }
        try await advance(setup, seconds: 3600)
        let steps = await executor.run()
        #expect(steps == [.reported(id: delivery.id, outcome: .succeeded, readBack: true)])
        #expect(setup.notes.lines == ["交水费"])
        let after = try await ask(setup, "交水费", call: "call-b", runId: runId)
        #expect(after["state"] as? String == "succeeded")
    }

    @Test func afterAReinstallOpenActionsAreCheckedNotExecuted() async throws {
        let setup = try await setUp()
        let (first, _) = try executor(setup, store: "before-reinstall")
        await first.run()
        let asked = try await ask(setup, "订机票", call: "call-c")
        let runId = try #require(asked["runId"] as? String)
        let claimed = try await setup.api.claimActions()
        let delivery = try #require(claimed.first)
        let (reinstalled, journal) = try executor(setup, store: "after-reinstall")
        #expect(!journal.exists)
        let steps = await reinstalled.run()
        #expect(steps == [.reported(id: delivery.id, outcome: .failed, readBack: true)])
        #expect(setup.notes.lines.isEmpty)
        #expect(journal.exists)
        let after = try await ask(setup, "订机票", call: "call-c", runId: runId)
        #expect(after["state"] as? String == "failed")
        #expect(after["reason"] as? String == DeviceActionReason.notDoneOnCheck.text(.chinese))
    }

    @Test func theSameActionArrivingAgainOnlyResendsTheEarlierResult() async throws {
        let setup = try await setUp()
        let (executor, journal) = try executor(setup)
        await executor.run()
        let asked = try await ask(setup, "倒垃圾", call: "call-d")
        let runId = try #require(asked["runId"] as? String)
        let claimed = try await setup.api.claimActions()
        let delivery = try #require(claimed.first)
        _ = try await setup.notes.perform(delivery)
        let earlier = DeviceActionReport(id: delivery.id, outcome: .succeeded, readBack: true, evidence: ["note": .string("earlier")], reason: nil)
        try journal.update {
            $0.entries[delivery.id] = DeviceActionJournalEntry(id: delivery.id, action: delivery.action, stage: .finished, before: nil, made: nil, report: earlier, updatedAt: setup.clock.now)
        }
        try await advance(setup, seconds: 3600)
        let steps = await executor.run()
        #expect(steps.isEmpty)
        #expect(setup.notes.lines == ["倒垃圾"])
        let after = try await ask(setup, "倒垃圾", call: "call-d", runId: runId)
        #expect(after["state"] as? String == "succeeded")
        #expect((after["evidence"] as? [String: Any])?["note"] as? String == "earlier")
        #expect(try journal.entry(delivery.id) == nil)
    }

    @Test func aReportTheServerRefusesIsKeptSoTheActionIsNeverRedone() async throws {
        let setup = try await setUp()
        let (executor, journal) = try executor(setup)
        await executor.run()
        let asked = try await ask(setup, "取快递", call: "call-e")
        let id = try #require(asked["actionId"] as? String)
        let claimed = try await setup.api.claimActions()
        #expect(claimed.map(\.id) == [id])
        try await advance(setup, seconds: 3600)
        let reclaimed = try await setup.api.claimActions()
        #expect(reclaimed.map(\.mode) == [.verify])
        let unchecked = DeviceActionReport(id: id, outcome: .failed, readBack: false, evidence: nil, reason: "没有核对")
        try journal.update {
            var entry = DeviceActionJournalEntry(id: id, action: "test.note.append", stage: .finished, before: nil, made: nil, report: unchecked, updatedAt: setup.clock.now)
            entry.keepUntil = setup.clock.now.addingTimeInterval(600)
            $0.entries[id] = entry
        }
        #expect(await executor.run() == [.replayed(id: id)])
        let kept = try #require(try journal.entry(id))
        #expect(kept.refused)
        #expect(kept.report == unchecked)
        #expect(await executor.run() == [.replayed(id: id)])
        #expect(setup.notes.lines.isEmpty)
        try await advance(setup, seconds: 3600)
        #expect(await executor.run() == [.reported(id: id, outcome: .failed, readBack: true)])
        #expect(try journal.entry(id) == nil)
        #expect(setup.notes.lines.isEmpty)
    }

    @Test func anActionThatCannotBeReadBackIsNotRedoneWhenChecked() async throws {
        let setup = try await setUp()
        let (executor, journal) = try executor(setup)
        await executor.run()
        let body: [String: Any] = ["deviceId": setup.deviceId, "action": "test.note.touch", "arguments": ["text": "摸一下"], "toolCallId": "call-g"]
        let asked = try await setup.control.call("request", body)
        let id = try #require(asked["actionId"] as? String)
        let claimed = try await setup.api.claimActions()
        let delivery = try #require(claimed.first)
        #expect(delivery.readBack == .none)
        _ = try await setup.notes.perform(delivery)
        try journal.update {
            $0.entries[id] = DeviceActionJournalEntry(id: id, action: delivery.action, stage: .started, before: nil, made: nil, report: nil, updatedAt: setup.clock.now)
        }
        try await advance(setup, seconds: 3600)
        let steps = await executor.run()
        #expect(steps.first == .reported(id: id, outcome: .resultUnknown, readBack: false))
        #expect(setup.notes.lines == ["摸一下"])
    }

    @Test func aNewerVersionOfAnActionIsNeitherDoneNorChecked() async throws {
        let setup = try await setUp()
        let (executor, _) = try executor(setup)
        await executor.run()
        let body: [String: Any] = ["deviceId": setup.deviceId, "action": "test.note.v2", "arguments": ["text": "新版本"], "toolCallId": "call-h"]
        let asked = try await setup.control.call("request", body)
        let id = try #require(asked["actionId"] as? String)
        #expect(await executor.run() == [.reported(id: id, outcome: .failed, readBack: false)])
        #expect(setup.notes.lines.isEmpty)
        let after = try await setup.control.call("request", body.merging(["runId": asked["runId"] ?? ""]) { $1 })
        #expect(after["reason"] as? String == DeviceActionReason.notSupported.text(.chinese))
    }

    @Test func aNewerVersionOfAnActionIsNotCheckedEither() async throws {
        let setup = try await setUp()
        let (executor, journal) = try executor(setup)
        await executor.run()
        let body: [String: Any] = ["deviceId": setup.deviceId, "action": "test.note.v2", "arguments": ["text": "新版本"], "toolCallId": "call-j"]
        let asked = try await setup.control.call("request", body)
        let id = try #require(asked["actionId"] as? String)
        try journal.update {
            $0.entries[id] = DeviceActionJournalEntry(id: id, action: "test.note.v2", stage: .started, before: nil, made: nil, report: nil, updatedAt: setup.clock.now)
        }
        #expect(await executor.run() == [.reported(id: id, outcome: .resultUnknown, readBack: false)])
        #expect(setup.notes.lines.isEmpty)
    }

    @Test func aRefusedRecordWithNoDeadlineIsClearedOnTheNextPass() async throws {
        let setup = try await setUp()
        let (executor, journal) = try executor(setup)
        await executor.run()
        let asked = try await ask(setup, "取快递", call: "call-k")
        let id = try #require(asked["actionId"] as? String)
        let claimed = try await setup.api.claimActions()
        #expect(claimed.map(\.id) == [id])
        try await advance(setup, seconds: 3600)
        let unchecked = DeviceActionReport(id: id, outcome: .failed, readBack: false, evidence: nil, reason: "没有核对")
        try journal.update {
            var entry = DeviceActionJournalEntry(id: id, action: "test.note.append", stage: .finished, before: nil, made: nil, report: unchecked, updatedAt: setup.clock.now)
            entry.refused = true
            entry.keepUntil = nil
            $0.entries[id] = entry
        }
        _ = await executor.run()
        #expect(setup.notes.lines.isEmpty)
        #expect(try journal.entry(id)?.refused != true)
    }

    @Test func aFinishedRecordWithoutAResultIsCheckedNotRedone() async throws {
        let setup = try await setUp()
        let (executor, journal) = try executor(setup)
        await executor.run()
        let asked = try await ask(setup, "浇花", call: "call-i")
        let id = try #require(asked["actionId"] as? String)
        try journal.update {
            $0.entries[id] = DeviceActionJournalEntry(id: id, action: "test.note.append", stage: .finished, before: nil, made: nil, report: nil, updatedAt: setup.clock.now)
        }
        #expect(await executor.run() == [.reported(id: id, outcome: .failed, readBack: true)])
        #expect(setup.notes.lines.isEmpty)
    }

    @Test func aDamagedJournalIsTreatedLikeAReinstall() async throws {
        let setup = try await setUp()
        let store = try FileLocalStore(directory: setup.directory.appendingPathComponent("damaged"))
        let journal = DeviceActionJournal(store: store)
        let executor = DeviceActionExecutor(transport: setup.api, journal: journal, handlers: [setup.notes], locale: .chinese, now: { setup.clock.now })
        await executor.run()
        _ = try await ask(setup, "寄明信片", call: "call-f")
        let claimed = try await setup.api.claimActions()
        let delivery = try #require(claimed.first)
        try store.write(DeviceActionJournal.fileName, Data("{not json".utf8))
        #expect(journal.lost)
        let steps = await executor.run()
        #expect(steps == [.reported(id: delivery.id, outcome: .failed, readBack: true)])
        #expect(setup.notes.lines.isEmpty)
        #expect(!journal.lost)
    }
}
