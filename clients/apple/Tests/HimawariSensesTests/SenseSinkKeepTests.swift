import Foundation
import HimawariCore
import Testing
@testable import HimawariSenses

struct RefusingTransport: PerceptionTransport, MirrorTransport {
    func ingest(_ records: [PerceptionRecordUpload]) async throws -> [String: PerceptionIngestOutcome] {
        throw DeviceAPIError.invalidResponse
    }

    func track(_ points: [TrackPointUpload]) async throws -> TrackIngestResult {
        throw DeviceAPIError.invalidResponse
    }

    func mirror(kind: String, mode: String, syncId: String, final: Bool, items: [MirrorItemUpload]) async throws -> MirrorSyncResult {
        throw DeviceAPIError.invalidResponse
    }
}

@MainActor
@Suite struct SenseSinkKeepTests {
    @Test func aRecordThatWasNotQueuedIsNotCountedAsKept() async {
        let store = MemoryLocalStore()
        let queue = PerceptionQueue(store: store, transport: RefusingTransport())
        let sink = SenseSink(queue: queue, mirror: MirrorSync(store: store, transport: RefusingTransport()), store: store, configuration: { nil })
        let observation = SenseObservations.health(.steps, value: 10, unit: "count", start: Date(timeIntervalSince1970: 0), end: Date(timeIntervalSince1970: 3600))
        let kept = await sink.keep(observation, id: "health-steps-0")
        #expect(!kept)
        let pending = await queue.pendingRecords
        #expect(pending.isEmpty)
    }

    @Test func healthIsReadAgainForTheLastTwoDaysEvenWhenTheCursorIsNewer() {
        let hour = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(HealthReadWindow.start(anchor: hour, lastFullHour: hour) == hour.addingTimeInterval(-48 * 3600))
        let older = hour.addingTimeInterval(-5 * 86_400)
        #expect(HealthReadWindow.start(anchor: older, lastFullHour: hour) == older)
    }
}
