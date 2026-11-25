import Foundation
import HimawariCore
import Testing
@testable import HimawariSenses

@MainActor
final class DeletingSensesService: SensesService {
    var server: SenseServerView? { nil }
    var deviceId: String? { "dev_this" }
    var operations: Set<String> { [SenseOperation.deleteRecords] }
    var totals: [String: Int] = [:]
    var cancels = false
    private(set) var asked: [String?] = []
    private(set) var deleted: [PerceptionDeletionTarget] = []

    func configuredRetention(_ key: String) -> Int? { nil }
    func authorization(_ item: SenseItem) async -> SenseAuthorization { .allowed }
    func requestAuthorization(_ item: SenseItem) async -> SenseAuthorization { .allowed }
    func alwaysAllowed(_ item: SenseItem) -> Bool? { nil }
    func requestAlways(_ item: SenseItem) async -> Bool { false }
    func start(_ item: SenseItem) {}
    func stop(_ item: SenseItem) async {}
    func status() async throws -> PerceptionStatusSnapshot {
        let json = #"{"state":"active","pausedUntil":null,"senses":[],"day":"2027-01-15","todayCount":0,"availableSenses":[],"retention":[{"key":"track","days":10,"defaultDays":10}],"revision":1}"#
        return try JSONDecoder().decode(PerceptionStatusSnapshot.self, from: Data(json.utf8))
    }
    func day(_ item: SenseItem) async throws -> PerceptionDaySnapshot { throw SensesGatewayError.notInstalled }
    func setSense(_ sense: String, enabled: Bool, revision: Int, reason: String) async throws {}
    func refreshServer() async {}
    func setRetention(key: String, days: Int?, revision: Int, reason: String) async throws {}
    func deleteRecords(_ item: SenseItem, reason: String) async throws -> PerceptionDeletionSnapshot { try await delete(.types(item.recordTypes, deviceId: deviceId), reason: reason) }
    func mirrorCount(_ item: SenseItem) async -> Int? { nil }
    func clearMirror(_ item: SenseItem) async throws {}

    func dayPage(_ day: String?, cursor: String?) async throws -> PerceptionDaySnapshot {
        asked.append(day)
        let total = day.flatMap { totals[$0] } ?? 0
        let rows = total == 0 ? "[]" : #"[{"kind":"episode","at":"2027-01-15T01:00:00Z","episode":{"id":"episode:00000000000000000000000000000001","startedAt":"2027-01-15T01:00:00Z","endedAt":"2027-01-15T01:45:00Z","recordCount":2,"senses":["hearing"],"types":["hearing.utterance"],"preview":"Meeting","summary":null},"record":null}]"#
        let json = #"{"day":"\#(day ?? "")","total":\#(total),"rows":\#(rows),"nextCursor":null}"#
        return try JSONDecoder().decode(PerceptionDaySnapshot.self, from: Data(json.utf8))
    }

    func episode(_ episodeId: String, cursor: String?) async throws -> PerceptionEpisodeSnapshot {
        PerceptionEpisodeSnapshot(episode: nil, records: [], nextCursor: nil)
    }

    func delete(_ target: PerceptionDeletionTarget, reason: String) async throws -> PerceptionDeletionSnapshot {
        if cancels { throw SensesGatewayError.confirmationCancelled }
        deleted.append(target)
        if case let .day(day, _) = target { totals[day] = 0 }
        let json = #"{"planId":"p","status":"verified","plan":null,"deleted":{"records":2,"trackPoints":1,"media":0},"pendingPayloads":0,"deletionRevision":1}"#
        return try JSONDecoder().decode(PerceptionDeletionSnapshot.self, from: Data(json.utf8))
    }
}

@MainActor
struct PerceptionDeletionModelTests {
    private func model(_ service: DeletingSensesService) -> PerceptionDeletionModel {
        PerceptionDeletionModel(senses: SensesModel(service: service, store: MemoryLocalStore()))
    }

    @Test func daysWithoutRecordsAreLeftOutAndEarlierDaysStopAtTheLongestRetention() async {
        let service = DeletingSensesService()
        service.totals = ["2027-01-15": 4, "2027-01-13": 2, "2027-01-07": 1]
        let model = model(service)
        await model.load()
        #expect(model.today == "2027-01-15")
        #expect(model.groups.map(\.day) == ["2027-01-15", "2027-01-14"])
        #expect(model.groups.map(\.rows.count) == [1, 0])
        #expect(model.days.map(\.day) == ["2027-01-15", "2027-01-13"])
        #expect(model.hasEarlierDays)
        await model.loadDays()
        #expect(model.days.map(\.day) == ["2027-01-15", "2027-01-13", "2027-01-07"])
        #expect(!model.hasEarlierDays)
    }

    @Test func deletingADayAsksTheServerOnceAndTheDayDisappears() async {
        let service = DeletingSensesService()
        service.totals = ["2027-01-15": 4, "2027-01-14": 3]
        let model = model(service)
        await model.load()
        #expect(await model.delete(.day("2027-01-14", deviceId: nil), reason: "x"))
        #expect(service.deleted == [.day("2027-01-14", deviceId: nil)])
        #expect(model.days.map(\.day) == ["2027-01-15"])
        #expect(model.notice != nil)
    }

    @Test func cancellingFaceIDDeletesNothingAndSaysNothing() async {
        let service = DeletingSensesService()
        service.totals = ["2027-01-15": 4]
        service.cancels = true
        let model = model(service)
        await model.load()
        #expect(await model.delete(.episode("episode:00000000000000000000000000000001"), reason: "x") == false)
        #expect(service.deleted.isEmpty)
        #expect(model.notice == nil)
        #expect(model.days.map(\.day) == ["2027-01-15"])
    }
}
