import Foundation
import Testing
@testable import HimawariCore

@Suite struct DeviceActionGateTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func delivery(expiresIn seconds: TimeInterval = 600, action: String = "calendar.delete", expiresAt: String? = nil) -> DeviceActionDelivery {
        DeviceActionDelivery(
            id: "dact_00000000000000000000000000000001",
            mode: .perform,
            action: action,
            schemaVersion: 1,
            arguments: ["eventId": .string("e1")],
            ownerPresence: true,
            readBack: .confirmAbsent,
            snapshotBefore: true,
            reversible: true,
            risk: "HIGH",
            expiresAt: expiresAt ?? DeviceActionTime.stamp(now.addingTimeInterval(seconds)),
            detail: ["zh-CN": "删除日程“周会”"]
        )
    }

    func refusal(_ delivery: DeviceActionDelivery, implemented: Bool = true, blocked: Bool = false, permission: DevicePermissionStatus = .authorized) -> DeviceActionReason? {
        DeviceActionGate.refusal(delivery, implemented: implemented, blocked: blocked, permission: permission, permissionName: ["zh-CN": "日历"], settingsPath: ["zh-CN": "设置"], now: now)
    }

    @Test func anAllowedActionPasses() {
        #expect(refusal(delivery()) == nil)
    }

    @Test func anActionThisDeviceCannotDoIsRefused() {
        #expect(refusal(delivery(action: "lights.explode"), implemented: false) == .notSupported)
    }

    @Test func theDevicePolicyIsCheckedOnTheDeviceToo() {
        #expect(refusal(delivery(), blocked: true) == .blockedByPolicy)
    }

    @Test func anExpiredActionIsNotDone() {
        #expect(refusal(delivery(expiresIn: -1)) == .expired)
        #expect(refusal(delivery(expiresIn: 0)) == .expired)
    }

    @Test func anExpiryThatCannotBeReadCountsAsExpired() {
        #expect(refusal(delivery(expiresAt: "")) == .expired)
        #expect(refusal(delivery(expiresAt: "tomorrow")) == .expired)
    }

    @Test func withoutSystemPermissionItSaysWhereToTurnItOn() {
        let reason = refusal(delivery(), permission: .denied)
        #expect(reason == .permission(["zh-CN": "日历"], settings: ["zh-CN": "设置"]))
        #expect(reason?.text(.chinese) == "系统里没允许 Himawari 使用日历，可以在设置里打开")
    }

    @Test func notYetAskedAndRestrictedPermissionsSayWhatIsTrue() {
        let notAsked = refusal(delivery(), permission: .notDetermined)
        #expect(notAsked == .permissionNotAsked(["zh-CN": "日历"]))
        #expect(notAsked?.text(.chinese) == "Himawari 还没问过能不能用日历。在 Himawari 的设置 › 系统里允许的 里点日历，再点“继续”")
        let restricted = refusal(delivery(), permission: .unavailable)
        #expect(restricted == .permissionUnavailable(["zh-CN": "日历"]))
        #expect(restricted?.text(.chinese).contains("设置里打开") == false)
    }

    @Test func aSchemaVersionTheHandlerWasNotWrittenForIsNotDone() throws {
        let notes = NoteFileActions(file: FileManager.default.temporaryDirectory.appendingPathComponent("unused-\(UUID().uuidString)"))
        let current = DeviceActionDelivery(
            id: "dact_00000000000000000000000000000002", mode: .perform, action: "test.note.append", schemaVersion: 1,
            arguments: ["text": .string("x")], ownerPresence: false, readBack: .readItem, snapshotBefore: false, reversible: false,
            risk: "LOW", expiresAt: DeviceActionTime.stamp(now.addingTimeInterval(600)), detail: [:]
        )
        let newer = DeviceActionDelivery(
            id: current.id, mode: .perform, action: current.action, schemaVersion: 2, arguments: current.arguments,
            ownerPresence: false, readBack: .readItem, snapshotBefore: false, reversible: false,
            risk: "LOW", expiresAt: current.expiresAt, detail: [:]
        )
        #expect(notes.handles(current))
        #expect(!notes.handles(newer))
    }

    @Test func checkingOnlyKeepsEverythingButTheMode() {
        let original = delivery()
        let checking = original.checkingOnly
        #expect(checking.mode == .verify)
        #expect(checking.id == original.id)
        #expect(checking.arguments == original.arguments)
        #expect(checking.readBack == original.readBack)
    }

    @Test func localTimesAreReadInTheDeviceTimeZoneAndRejectImpossibleDates() throws {
        let tokyo = try #require(TimeZone(identifier: "Asia/Tokyo"))
        let date = try #require(DeviceActionTime.localDate("2026-11-20T15:00", in: tokyo))
        #expect(DeviceActionTime.stamp(date) == "2026-11-20T06:00:00.000Z")
        #expect(DeviceActionTime.localText(date, in: tokyo) == "2026-11-20T15:00")
        #expect(DeviceActionTime.localDate("2026-02-30T10:00", in: tokyo) == nil)
        #expect(DeviceActionTime.localDate("2026-11-20T25:00", in: tokyo) == nil)
        #expect(DeviceActionTime.localDate("2026-11-20T15:00:00Z", in: tokyo) == nil)
        #expect(DeviceActionTime.localDate("2026-11-20T15:00:abc", in: tokyo) == nil)
        #expect(DeviceActionTime.localDate("2026-11-20T15:00Z", in: tokyo) == nil)
        #expect(DeviceActionTime.localDate("2026-11-2", in: tokyo) == nil)
        #expect(DeviceActionTime.localDate("2026-11-20", in: tokyo).map { DeviceActionTime.localText($0, in: tokyo) } == "2026-11-20T00:00")
    }

    @Test func argumentsOfTheWrongTypeAreRefusedNotGuessed() throws {
        let args = DeviceActionArguments(["title": .number(3), "level": .number(40.5), "on": .bool(true)])
        #expect(throws: DeviceActionFailure(.badArguments)) { try args.string("title") }
        #expect(throws: DeviceActionFailure(.badArguments)) { try args.optionalInteger("level") }
        #expect(throws: DeviceActionFailure(.badArguments)) { try args.string("missing") }
        #expect(try args.optionalBool("on") == true)
        #expect(try args.optionalString("missing") == nil)
    }

    @Test func wholeNumbersAreSentAsIntegers() throws {
        let data = try JSONEncoder().encode(DeviceActionValue.object(["level": .number(40), "temperature": .number(21.5)]))
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.contains("\"level\":40") && !text.contains("40.0"))
        #expect(text.contains("21.5"))
        #expect(try JSONDecoder().decode(DeviceActionValue.self, from: data) == .object(["level": .number(40), "temperature": .number(21.5)]))
    }

    @Test func aSucceededReportCarriesNoReason() {
        let report = DeviceActionReport(id: "dact_1", outcome: .succeeded, readBack: true, evidence: nil, reason: "x")
        #expect(report.reason == nil)
    }

    @Test func anActionTheAppHasNeverHeardOfStillDecodesWithTheServersWords() throws {
        let json = #"""
        {"actions":[{"id":"dact_1","deviceId":"d1","state":"some_new_state","detail":{"zh-CN":"给猫喂食：两勺","en":"Feed the cat: two scoops"},"risk":"MEDIUM","ownerPresence":false,"reversible":false,"reasonCode":null,"reason":null,"createdAt":"2026-11-13T01:00:00.000Z","updatedAt":"2026-11-13T01:00:00.000Z","confirmLabel":{"zh-CN":"喂","en":"Feed","ja":"あげる"},"declineLabel":{"zh-CN":"不喂","en":"Don't feed","ja":"あげない"},"action":"pet.feeder.dispense","runId":"run-1","threadId":null}]}
        """#
        struct Body: Decodable { let actions: [DeviceActionView] }
        let view = try #require(try JSONDecoder().decode(Body.self, from: Data(json.utf8)).actions.first)
        #expect(view.state == nil)
        #expect(view.rawState == "some_new_state")
        #expect(view.detail.localized(.english) == "Feed the cat: two scoops")
        #expect(view.detail.localized(.japanese) == "给猫喂食：两勺")
        #expect(view.confirmLabel?.localized(.chinese) == "喂")
        #expect(view.declineLabel?.localized(.english) == "Don't feed")
        #expect(view.threadId == nil)
        let reencoded = try JSONDecoder().decode(DeviceActionView.self, from: JSONEncoder().encode(view))
        #expect(reencoded == view)
    }

    @Test func oneOccurrenceOfARepeatingEventIsNamedByItsEventAndLocalStart() throws {
        let tokyo = try #require(TimeZone(identifier: "Asia/Tokyo"))
        let start = try #require(DeviceActionTime.localDate("2026-11-14T15:00", in: tokyo))
        let id = CalendarOccurrenceId.make(eventIdentifier: "ABC:123#x", start: start, in: tokyo)
        #expect(id == "ABC:123#x#2026-11-14T15:00")
        let parts = CalendarOccurrenceId.split(id, in: tokyo)
        #expect(parts.eventIdentifier == "ABC:123#x")
        #expect(parts.start == start)
        let plain = CalendarOccurrenceId.split("ABC:123#x", in: tokyo)
        #expect(plain.eventIdentifier == "ABC:123#x")
        #expect(plain.start == nil)
    }

    @Test func readAndSyncNameAnEventTheSameWayChangeAndDeleteExpect() throws {
        let tokyo = try #require(TimeZone(identifier: "Asia/Tokyo"))
        let start = try #require(DeviceActionTime.localDate("2026-11-28T19:00", in: tokyo))
        let repeating = CalendarOccurrenceId.of(eventIdentifier: "EV1", start: start, recurring: true, in: tokyo)
        #expect(repeating == "EV1#2026-11-28T19:00")
        #expect(CalendarOccurrenceId.split(repeating, in: tokyo).start == start)
        let single = CalendarOccurrenceId.of(eventIdentifier: "EV2", start: start, recurring: false, in: tokyo)
        #expect(single == "EV2")
        #expect(CalendarOccurrenceId.split(single, in: tokyo).start == nil)
    }
}

@Suite struct DeviceActionListingTests {
    func item(_ index: Int) -> JSONObject {
        ["eventId": .string("evt-\(index)"), "title": .string(String(repeating: "日", count: 40))]
    }

    @Test func keepsEveryItemThatFitsAndSaysNothingWasLeftOut() throws {
        let listed = DeviceActionListing.fit((0..<3).map(item), as: "events", within: 64 * 1024)
        #expect(listed["events"]?.arrayCount == 3)
        #expect(listed["truncated"] == .bool(false))
    }

    @Test func stopsBeforeTheServerLimitAndSaysSomeWereLeftOut() throws {
        let limit = 2_000
        let listed = DeviceActionListing.fit((0..<100).map(item), as: "events", within: limit)
        #expect(listed["truncated"] == .bool(true))
        let kept = try #require(listed["events"]?.arrayCount)
        #expect(kept > 0 && kept < 100)
        let size = try JSONEncoder().encode(["done": DeviceActionValue.object(listed)]).count
        #expect(size <= limit)
        let oneMore = DeviceActionListing.fit((0...kept).map(item), as: "events", within: limit)
        #expect(oneMore["truncated"] == .bool(true))
    }

    @Test func withoutALimitFromTheServerNothingIsLeftOut() {
        let listed = DeviceActionListing.fit((0..<100).map(item), as: "events", within: nil)
        #expect(listed["events"]?.arrayCount == 100)
    }
}

private extension DeviceActionValue {
    var arrayCount: Int? {
        if case let .array(items) = self { return items.count }
        return nil
    }
}

@Suite struct DeviceActionSourceTests {
    @Test func eachActionNamesThePermissionItNeeds() async {
        let executor = DeviceActionExecutor(
            transport: DeviceAPI(http: DeviceHTTPClient()),
            journal: DeviceActionJournal(store: MemoryLocalStore()),
            handlers: [NoteFileActions(file: FileManager.default.temporaryDirectory.appendingPathComponent("unused-notes"))]
        )
        let ids = await executor.permissionIds()
        #expect(ids == ["test.note.append": "notes", "test.note.touch": "notes", "test.note.v2": "notes"])
        #expect(ids["calendar.delete"] == nil)
    }
}
