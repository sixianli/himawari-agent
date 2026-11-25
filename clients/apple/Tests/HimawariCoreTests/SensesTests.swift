import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import HimawariCore

@Suite struct SensesTests {
    private let moment = Date(timeIntervalSince1970: 1_800_000_000)

    private static let types: [String: PerceptionTypeRule] = [
        "location.visit": PerceptionTypeRule(sense: "location", text: "none", evidence: [
            "latitude": PerceptionFieldRule(kind: "number", maximum: nil, optional: nil),
            "longitude": PerceptionFieldRule(kind: "number", maximum: nil, optional: nil),
            "accuracyMeters": PerceptionFieldRule(kind: "number", maximum: nil, optional: true),
            "arrivedAtMs": PerceptionFieldRule(kind: "integer", maximum: nil, optional: true),
            "departedAtMs": PerceptionFieldRule(kind: "integer", maximum: nil, optional: true),
            "placeName": PerceptionFieldRule(kind: "string", maximum: 6, optional: true),
        ]),
        "location.region": PerceptionTypeRule(sense: "location", text: "none", evidence: [
            "regionId": PerceptionFieldRule(kind: "string", maximum: 128, optional: nil),
            "transition": PerceptionFieldRule(kind: "enum", maximum: nil, optional: nil),
        ]),
        "clipboard.item": PerceptionTypeRule(sense: "reading", text: "required", evidence: [
            "sourceApp": PerceptionFieldRule(kind: "string", maximum: 128, optional: true),
        ]),
        "health.sample": PerceptionTypeRule(sense: "body", text: "none", evidence: [
            "subtype": PerceptionFieldRule(kind: "enum", maximum: nil, optional: nil),
            "value": PerceptionFieldRule(kind: "number", maximum: nil, optional: nil),
            "unit": PerceptionFieldRule(kind: "string", maximum: 16, optional: nil),
            "startMs": PerceptionFieldRule(kind: "integer", maximum: nil, optional: true),
            "endMs": PerceptionFieldRule(kind: "integer", maximum: nil, optional: true),
        ]),
        "motion.activity": PerceptionTypeRule(sense: "body", text: "none", evidence: [
            "activity": PerceptionFieldRule(kind: "enum", maximum: nil, optional: nil),
        ]),
        "photo.asset": PerceptionTypeRule(sense: "vision", text: "optional", evidence: [
            "assetId": PerceptionFieldRule(kind: "string", maximum: 128, optional: nil),
        ]),
        "photo.screenshot": PerceptionTypeRule(sense: "vision", text: "optional", evidence: [
            "assetId": PerceptionFieldRule(kind: "string", maximum: 128, optional: nil),
        ]),
    ]

    private func configuration(recordBatch: Int64 = 2, trackBatch: Int64 = 2, mirrorBatch: Int64 = 2) -> DeviceConfiguration {
        let limits = [
            DeviceLimit(key: "device.perception.batch_records", unit: "records", value: recordBatch, defaultValue: 500, onExceed: "reject"),
            DeviceLimit(key: "device.track.batch_points", unit: "points", value: trackBatch, defaultValue: 2000, onExceed: "reject"),
            DeviceLimit(key: "device.mirror.batch_items", unit: "items", value: mirrorBatch, defaultValue: 500, onExceed: "reject"),
        ]
        return DeviceConfiguration(
            heartbeatSeconds: 25,
            connectionMaxSeconds: 3600,
            signatureToleranceSeconds: 300,
            limits: limits,
            streamConnections: 2,
            attachments: nil,
            perception: PerceptionSummary(
                recordTextCharacters: 8,
                recordTypes: Self.types,
                state: "sensing",
                pausedUntil: nil,
                senses: [
                    PerceptionSenseSwitch(sense: "location", enabled: true),
                    PerceptionSenseSwitch(sense: "body", enabled: true),
                    PerceptionSenseSwitch(sense: "vision", enabled: false),
                    PerceptionSenseSwitch(sense: "reading", enabled: true),
                ],
                retentionDays: ["track": 90, "surroundings": 30]
            )
        )
    }

    private func api(_ exchange: RecordingExchange) throws -> DeviceAPI {
        let http = DeviceHTTPClient(exchange: exchange, now: { Date(timeIntervalSince1970: 1_800_000_000) })
        http.use(DeviceCredentials(origin: try #require(URL(string: "https://himawari.example.test:8443/")), deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", access: nil, deviceKey: try SoftwareKeySigner()))
        return DeviceAPI(http: http)
    }

    private func json(_ object: Any) -> HTTPExchangeResponse {
        HTTPExchangeResponse(status: 200, body: try! JSONSerialization.data(withJSONObject: object))
    }

    private func body(_ request: URLRequest) throws -> [String: Any] {
        let data = try #require(request.httpBody)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func temporaryStore() throws -> FileLocalStore {
        try FileLocalStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent("senses-\(UUID().uuidString)", isDirectory: true))
    }

    @Test func eachItemShowsOnOnlyWhenSwitchSystemAndServerAllAgree() {
        let server = SenseServerView.from(configuration())
        #expect(SenseStateRule.state(item: .location, switchedOn: true, authorization: .allowed, server: server) == .on)
        #expect(SenseStateRule.state(item: .location, switchedOn: false, authorization: .allowed, server: server) == .off)
        #expect(SenseStateRule.state(item: .location, switchedOn: true, authorization: .denied, server: server) == .systemDenied)
        #expect(SenseStateRule.state(item: .location, switchedOn: true, authorization: .notAsked, server: server) == .off)
        #expect(SenseStateRule.state(item: .photos, switchedOn: true, authorization: .limited, server: server) == .off)
        #expect(SenseStateRule.state(item: .calendar, switchedOn: true, authorization: .allowed, server: server) == .on)
        let paused = SenseServerView(state: "paused", enabledSenses: ["location"], knownTypes: nil)
        #expect(SenseStateRule.state(item: .location, switchedOn: true, authorization: .allowed, server: paused) == .serverPaused)
        let older = SenseServerView(state: "sensing", enabledSenses: ["location"], knownTypes: ["location.visit"])
        #expect(SenseStateRule.state(item: .location, switchedOn: true, authorization: .allowed, server: older) == .serverUnsupported)
        #expect(SenseStateRule.state(item: .location, switchedOn: true, authorization: .allowed, server: nil) == .on)
    }

    @Test func openingAnItemFollowsIntroThenSystemThenServer() {
        let server = SenseServerView.from(configuration())
        #expect(SenseStateRule.opening(item: .photos, introSeen: false, authorization: .notAsked, server: server) == .showIntro)
        #expect(SenseStateRule.opening(item: .photos, introSeen: true, authorization: .notAsked, server: server) == .askSystem)
        #expect(SenseStateRule.opening(item: .photos, introSeen: true, authorization: .denied, server: server) == .showDenied)
        #expect(SenseStateRule.opening(item: .photos, introSeen: true, authorization: .allowed, server: server) == .needsServerSense)
        #expect(SenseStateRule.opening(item: .location, introSeen: true, authorization: .allowed, server: server) == .ready)
        #expect(SenseStateRule.opening(item: .contacts, introSeen: true, authorization: .allowed, server: server) == .ready)
    }

    @Test func switchesSurviveARestartOfTheStore() throws {
        let store = try temporaryStore()
        try SenseSwitches(store: store).update(.clipboard) { $0.on = true; $0.introSeen = true }
        let reopened = SenseSwitches(store: store)
        #expect(reopened.state(.clipboard) == SenseSwitchState(on: true, introSeen: true, askedAlways: false))
        #expect(reopened.state(.location) == SenseSwitchState())
    }

    @Test func recordsFollowTheServerRulesForTextAndEvidence() throws {
        let visit = SenseObservations.visit(latitude: 34.73, longitude: 135.5, accuracyMeters: 20, arrivedAt: moment, departedAt: moment.addingTimeInterval(7200.4), placeName: "新大阪駅前の店")
        let record = try SenseRecordBuilder.record(visit, types: Self.types, textLimit: 8)
        #expect(record.id.range(of: #"^perception:[A-Za-z0-9_-]{16,64}$"#, options: .regularExpression) != nil)
        #expect(record.text == nil)
        #expect(record.evidence["placeName"] == .string("新大阪駅前の"))
        #expect(record.evidence["departedAtMs"] == .number(1_800_007_200_400))
        #expect(record.captureSource == "system_api")
        let encoded = try #require(String(data: try JSONEncoder().encode(record), encoding: .utf8))
        #expect(encoded.contains("\"arrivedAtMs\":1800000000000"))

        let copied = try SenseRecordBuilder.record(SenseObservations.clipboard(text: "0123456789", sourceApp: nil, at: moment), types: Self.types, textLimit: 8)
        #expect(copied.text == "01234567")
        #expect(throws: SenseRecordError.textMissing) {
            try SenseRecordBuilder.record(SenseObservations.clipboard(text: "", sourceApp: nil, at: moment), types: Self.types, textLimit: 8)
        }
        #expect(throws: SenseRecordError.typeUnknown("context.power")) {
            try SenseRecordBuilder.record(SenseObservation(type: "context.power", occurredAt: moment, evidence: [:]), types: Self.types, textLimit: nil)
        }
        #expect(throws: SenseRecordError.fieldMissing("regionId")) {
            try SenseRecordBuilder.record(SenseObservation(type: "location.region", occurredAt: moment, evidence: ["transition": .string("enter")]), types: Self.types, textLimit: nil)
        }
        let screenshot = SenseObservations.photo(assetId: "A/L0/001", screenshot: true, createdAt: moment, latitude: 1, longitude: 2)
        #expect(screenshot.type == "photo.screenshot")
        #expect(screenshot.evidence["latitude"] == nil)
        #expect(SenseRecordBuilder.stableId(["photo", "A/L0/001"]) == SenseRecordBuilder.stableId(["photo", "A/L0/001"]))
    }

    @Test func queueSendsInServerSizedBatchesAndKeepsWhatTheServerDidNotSettle() async throws {
        let exchange = RecordingExchange([])
        let store = try temporaryStore()
        let queue = PerceptionQueue(store: store, transport: try api(exchange))
        var ids: [String] = []
        for index in 0..<3 {
            let record = try SenseRecordBuilder.record(SenseObservations.clipboard(text: "c\(index)", sourceApp: nil, at: moment), types: Self.types, textLimit: 8)
            ids.append(record.id)
            try await queue.add(record)
        }
        exchange.enqueue(json(["outcomes": [["id": ids[0], "outcome": "stored"], ["id": ids[1], "outcome": "sense_off"]], "reached": [String]()]))
        exchange.enqueue(json(["outcomes": [["id": ids[2], "outcome": "limit_reached"]], "reached": [String]()]))
        let report = await queue.flush(configuration: configuration(), today: "2027-01-15")
        #expect(report.stored == 1)
        #expect(report.turnedAway == 1)
        #expect(report.limitReached)
        #expect(await queue.pendingRecords.map(\.id) == [ids[2]])
        #expect(exchange.requests.count == 2)
        let first = try body(exchange.requests[0])
        #expect((first["records"] as? [[String: Any]])?.count == 2)
        #expect(exchange.requests[0].url?.path == "/api/device/v1/perception")

        let again = await PerceptionQueue(store: store, transport: try api(exchange)).flush(configuration: configuration(), today: "2027-01-15")
        #expect(again.limitReached)
        #expect(exchange.requests.count == 2)
    }

    @Test func aRecordTheServerRefusesIsIsolatedByHalvingAndDropped() async throws {
        let exchange = RecordingExchange([])
        let queue = PerceptionQueue(store: try temporaryStore(), transport: try api(exchange))
        var ids: [String] = []
        for index in 0..<2 {
            let record = try SenseRecordBuilder.record(SenseObservations.clipboard(text: "c\(index)", sourceApp: nil, at: moment), types: Self.types, textLimit: 8)
            ids.append(record.id)
            try await queue.add(record)
        }
        exchange.enqueue(HTTPExchangeResponse(status: 400, body: Data(#"{"error":{"code":"DEVICE_REQUEST_INVALID"}}"#.utf8)))
        exchange.enqueue(HTTPExchangeResponse(status: 400, body: Data(#"{"error":{"code":"DEVICE_REQUEST_INVALID"}}"#.utf8)))
        exchange.enqueue(json(["outcomes": [["id": ids[1], "outcome": "stored"]], "reached": [String]()]))
        let report = await queue.flush(configuration: configuration(), today: "2027-01-15")
        #expect(report.malformed == 1)
        #expect(report.stored == 1)
        #expect(await queue.pendingRecords.isEmpty)
        #expect(exchange.requests.count == 3)
    }

    @Test func networkTroubleKeepsEverythingForTheNextTry() async throws {
        let exchange = RecordingExchange([])
        let queue = PerceptionQueue(store: try temporaryStore(), transport: try api(exchange))
        try await queue.add(TrackPointUpload(at: moment, latitude: 1, longitude: 2, accuracyMeters: -1, speedMetersPerSecond: 3))
        exchange.enqueue(HTTPExchangeResponse(status: 503, body: Data()))
        let report = await queue.flush(configuration: configuration(), today: "2027-01-15")
        #expect(report.stoppedBy != nil)
        #expect(await queue.pendingPoints.count == 1)
        exchange.enqueue(json(["stored": 1, "duplicates": 0, "limitReached": 0]))
        _ = await queue.flush(configuration: configuration(), today: "2027-01-15")
        #expect(await queue.pendingPoints.isEmpty)
        let sent = try body(exchange.requests[1])
        let point = try #require((sent["points"] as? [[String: Any]])?.first)
        #expect(Set(point.keys) == ["occurredAt", "latitude", "longitude", "speedMetersPerSecond"])
        #expect(point["occurredAt"] as? String == "2027-01-15T08:00:00.000Z")
    }

    @Test func mirrorSendsEverythingFirstThenOnlyChangesAndRemovals() async throws {
        let exchange = RecordingExchange([])
        let store = try temporaryStore()
        let clock = Clock(moment)
        let sync = MirrorSync(store: store, transport: try api(exchange), now: { clock.now })
        let a = MirrorEntry(externalId: "a", data: ["name": .string("田中")])
        let b = MirrorEntry(externalId: "b", data: ["name": .string("佐藤")])
        let c = MirrorEntry(externalId: "c", data: ["name": .string("鈴木")])
        exchange.enqueue(json(["applied": 2, "stale": 0, "removed": 0, "active": 2]))
        exchange.enqueue(json(["applied": 1, "stale": 0, "removed": 0, "active": 3]))
        try await sync.sync(kind: "contact", entries: [c, a, b], batchSize: 2)
        #expect(await sync.activeCount(kind: "contact") == 3)
        let first = try body(exchange.requests[0])
        let second = try body(exchange.requests[1])
        #expect(first["mode"] as? String == "full")
        #expect(first["final"] as? Bool == false)
        #expect(second["final"] as? Bool == true)
        #expect(first["syncId"] as? String == second["syncId"] as? String)
        #expect((first["items"] as? [[String: Any]])?.map { $0["externalId"] as? String } == ["a", "b"])

        clock.now = moment.addingTimeInterval(60)
        exchange.enqueue(json(["applied": 2, "stale": 0, "removed": 0, "active": 2]))
        try await sync.sync(kind: "contact", entries: [MirrorEntry(externalId: "a", data: ["name": .string("田中一郎")]), b], batchSize: 10)
        let delta = try body(exchange.requests[2])
        #expect(delta["mode"] as? String == "delta")
        let items = try #require(delta["items"] as? [[String: Any]])
        #expect(items.map { $0["externalId"] as? String } == ["a", "c"])
        #expect(items[1]["deleted"] as? Bool == true)
        #expect(items[1]["data"] == nil)
        #expect((items[0]["version"] as? Int ?? 0) > (try #require((first["items"] as? [[String: Any]])?.first?["version"] as? Int)))

        let unchanged = try await sync.sync(kind: "contact", entries: [MirrorEntry(externalId: "a", data: ["name": .string("田中一郎")]), b], batchSize: 10)
        #expect(unchanged == nil)
        #expect(exchange.requests.count == 3)

        exchange.enqueue(json(["applied": 0, "stale": 0, "removed": 2, "active": 0]))
        try await sync.clear(kind: "contact")
        let cleared = try body(exchange.requests[3])
        #expect(cleared["mode"] as? String == "full")
        #expect(cleared["final"] as? Bool == true)
        #expect((cleared["items"] as? [Any])?.isEmpty == true)
        #expect(await sync.activeCount(kind: "contact") == 0)
    }

    @Test func mirrorFieldsAreCutToTheServerRulesAndIncompleteItemsAreSkipped() {
        let rules: [String: PerceptionFieldRule] = [
            "title": PerceptionFieldRule(kind: "string", maximum: 3, optional: nil),
            "allDay": PerceptionFieldRule(kind: "boolean", maximum: nil, optional: nil),
            "notes": PerceptionFieldRule(kind: "string", maximum: 10, optional: true),
        ]
        #expect(MirrorFields.fit(["title": .string("会議の準備"), "allDay": .bool(false), "extra": .string("x")], rules: rules) == ["title": .string("会議の"), "allDay": .bool(false)])
        #expect(MirrorFields.fit(["allDay": .bool(true)], rules: rules) == nil)
    }

    @Test func deletionsMadeOnTheServerAlsoRemoveWhatThisIPhoneHasNotSentYet() async throws {
        let exchange = RecordingExchange([])
        let store = try temporaryStore()
        let deviceAPI = try api(exchange)
        let queue = PerceptionQueue(store: store, transport: deviceAPI)
        let visit = try SenseRecordBuilder.record(SenseObservations.visit(latitude: 34.7, longitude: 135.5, accuracyMeters: nil, arrivedAt: moment, departedAt: nil, placeName: nil), types: Self.types, textLimit: 8)
        let morning = try SenseRecordBuilder.record(SenseObservations.clipboard(text: "a", sourceApp: nil, at: moment), types: Self.types, textLimit: 8)
        let later = try SenseRecordBuilder.record(SenseObservations.clipboard(text: "b", sourceApp: nil, at: moment.addingTimeInterval(3600)), types: Self.types, textLimit: 8)
        let health = try SenseRecordBuilder.record(SenseObservations.motion(.walking, certainty: .high, at: moment.addingTimeInterval(-86_400)), types: Self.types, textLimit: 8)
        for record in [visit, morning, later, health] { try await queue.add(record) }
        try await queue.add(TrackPointUpload(at: moment, latitude: 34.7, longitude: 135.5, accuracyMeters: nil, speedMetersPerSecond: nil))
        let through = HandoverPlanner.timestamp(moment.addingTimeInterval(60))
        func scope(_ revision: Int, _ kind: String, device: Any = NSNull(), day: Any = NSNull(), types: [String] = [], ids: [String] = [], track: Bool = false) -> [String: Any] {
            ["revision": revision, "kind": kind, "deviceId": device, "day": day, "types": types, "recordIds": ids, "includesTrack": track, "through": through]
        }
        exchange.enqueue(json(["revision": 2, "latest": 3, "scopes": [
            scope(1, "types", device: "dev_other", types: ["motion.activity"]),
            scope(2, "records", ids: [visit.id]),
        ]]))
        exchange.enqueue(json(["revision": 3, "latest": 3, "scopes": [scope(3, "day", day: "2027-01-15", track: true)]]))
        let sync = PerceptionDeletionSync(store: store, source: deviceAPI, queue: queue, thisDevice: "dev_this", timeZone: TimeZone(identifier: "UTC")!)
        #expect(await sync.sync() == 3)
        #expect(await queue.pendingRecords.map(\.id).sorted() == [later.id, health.id].sorted())
        #expect(await queue.pendingPoints.isEmpty)
        #expect(exchange.requests.map { $0.url?.query } == ["after=0", "after=2"])
        #expect(exchange.requests.allSatisfy { $0.httpMethod == "GET" && $0.url?.path == "/api/device/v1/perception/deletions" })
        #expect(await sync.revision == 3)

        exchange.enqueue(json(["revision": 3, "latest": 3, "scopes": [[String: Any]]()]))
        let reopened = PerceptionDeletionSync(store: store, source: deviceAPI, queue: queue, thisDevice: "dev_this", timeZone: TimeZone(identifier: "UTC")!)
        #expect(await reopened.sync() == 0)
        #expect(exchange.requests.last?.url?.query == "after=3")
        #expect(await queue.pendingRecords.count == 2)
    }

    @Test func deletionTargetsSendEveryFieldTheServerChecks() throws {
        func encoded(_ target: PerceptionDeletionTarget) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(target)) as? [String: Any])
        }
        let records = try encoded(.records(["perception:AAAAAAAAAAAAAAAAAAAAAAAA"]))
        #expect(records["kind"] as? String == "records")
        #expect(records["ids"] as? [String] == ["perception:AAAAAAAAAAAAAAAAAAAAAAAA"])
        #expect(Set(records.keys) == ["kind", "ids", "episodeId", "day", "deviceId", "types"])
        let day = try encoded(.day("2027-01-15", deviceId: nil))
        #expect(day["day"] as? String == "2027-01-15")
        #expect(day["deviceId"] is NSNull)
        #expect(day["ids"] as? [String] == [])
        #expect(try encoded(.episode("episode:x"))["episodeId"] as? String == "episode:x")
        #expect(PerceptionTime.shift(day: "2027-03-01", by: -1) == "2027-02-28")
        #expect(PerceptionTime.shift(day: "2027-01-01", by: -1) == "2026-12-31")
    }

    @Test func gatewayReadsAskForTheItemTypesAndTurningOnOrDeletingAsksForFaceID() async throws {
        let exchange = RecordingExchange([])
        let gateway = SensesGateway(api: try api(exchange), confirmation: Confirmation(signer: try SoftwareKeySigner()))
        exchange.enqueue(json(["type": "perception.day.snapshot", "payload": ["day": "2027-01-15", "total": 1, "rows": [], "nextCursor": NSNull()]]))
        let day = try await gateway.day(types: SenseItem.location.recordTypes)
        #expect(day.total == 1)
        let read = try body(exchange.requests[0])
        #expect(read["type"] as? String == "perception.day.read")
        #expect(read["gateway"] as? String == "v2")
        #expect(read["idempotencyKey"] == nil)
        let payload = try #require(read["payload"] as? [String: Any])
        #expect(payload["types"] as? [String] == ["location.visit", "location.region"])
        #expect(payload["day"] is NSNull)

        exchange.enqueue(json(["challenge": "CHALLENGEVALUE", "expiresAt": "2027-01-15T08:05:00Z"]))
        exchange.enqueue(json(["type": "command.result", "payload": [:]]))
        try await gateway.setSense("vision", enabled: true, expectedRevision: 4, reason: "打开相册")
        #expect(exchange.requests[1].url?.path == "/api/device/v1/approvals/challenge")
        let change = exchange.requests[2]
        let input = try #require(change.value(forHTTPHeaderField: "Signature-Input"))
        #expect(input.contains("confirm="))
        #expect(input.contains("nonce=\"CHALLENGEVALUE\""))
        let command = try body(change)
        #expect(command["idempotencyKey"] as? String == command["messageId"] as? String)
        #expect((command["payload"] as? [String: Any])?["sense"] as? String == "vision")

        exchange.enqueue(json(["type": "command.result", "payload": [:]]))
        try await gateway.setSense("vision", enabled: false, expectedRevision: 5, reason: "关掉相册")
        #expect(exchange.requests[3].value(forHTTPHeaderField: "Signature-Input")?.contains("confirm=") == false)

        exchange.enqueue(json(["type": "perception.deletion.snapshot", "payload": Self.deletion(status: "planned")]))
        exchange.enqueue(json(["challenge": "DELETECHALLENGE", "expiresAt": "2027-01-15T08:06:00Z"]))
        exchange.enqueue(json(["type": "command.result", "payload": [:]]))
        exchange.enqueue(json(["type": "perception.deletion.snapshot", "payload": Self.deletion(status: "verified")]))
        let deleted = try await gateway.delete(.types(["location.visit"], deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA"), reason: "删")
        #expect(deleted.status == "verified")
        #expect(deleted.removed == 3)
        let plan = try body(exchange.requests[4])
        #expect(plan["type"] as? String == "perception.deletion.plan")
        #expect(exchange.requests[4].value(forHTTPHeaderField: "Signature-Input")?.contains("confirm=") == false)
        let target = try #require(plan["payload"] as? [String: Any])
        #expect(target["kind"] as? String == "types")
        #expect(target["types"] as? [String] == ["location.visit"])
        #expect(target["ids"] as? [String] == [])
        #expect(target["episodeId"] is NSNull)
        #expect(target["day"] is NSNull)
        #expect(target["deviceId"] as? String == "dev_AAAAAAAAAAAAAAAAAAAAAA")
        #expect(exchange.requests[5].url?.path == "/api/device/v1/approvals/challenge")
        #expect(exchange.requests[6].value(forHTTPHeaderField: "Signature-Input")?.contains("nonce=\"DELETECHALLENGE\"") == true)
        let delete = try body(exchange.requests[6])
        #expect(delete["type"] as? String == "perception.records.delete")
        #expect((delete["payload"] as? [String: Any])?["planId"] as? String == "plan-1")
        let readBack = try body(exchange.requests[7])
        #expect(readBack["type"] as? String == "perception.deletion.read")
        #expect((readBack["payload"] as? [String: Any])?["planId"] as? String == "plan-1")

        exchange.enqueue(HTTPExchangeResponse(status: 404, body: Data(#"{"error":{"code":"DEVICE_GATEWAY_TYPE_UNKNOWN"}}"#.utf8)))
        await #expect(throws: SensesGatewayError.notInstalled) {
            _ = try await gateway.delete(.episode("episode:0123456789abcdef0123456789abcdef"), reason: "删")
        }
        #expect(exchange.requests.count == 9)
    }

    static func deletion(status: String) -> [String: Any] {
        let counts: [String: Any] = ["records": 2, "trackPoints": 1, "media": 0]
        return [
            "planId": "plan-1", "status": status, "plan": counts, "deleted": status == "verified" ? counts : NSNull(),
            "expiresAt": "2027-01-15T08:10:00Z", "pendingPayloads": 0, "deletionRevision": 7, "keptElsewhere": [],
            "generatedAt": "2027-01-15T08:00:00Z",
        ]
    }
}

final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Date

    init(_ value: Date) {
        self.value = value
    }

    var now: Date {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

struct Confirmation: ConfirmationSigner {
    let signer: SoftwareKeySigner

    func confirmKey() -> DeviceKeySigner { signer }
}
