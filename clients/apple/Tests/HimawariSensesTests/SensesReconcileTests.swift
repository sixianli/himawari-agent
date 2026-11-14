import Foundation
import HimawariCore
import Testing
@testable import HimawariSenses

@MainActor
final class RecordingSensesService: SensesService {
    var server: SenseServerView?
    var authorizationValue: SenseAuthorization = .allowed
    var deviceId: String? { nil }
    var operations: Set<String> { [] }
    private(set) var started: [SenseItem] = []
    private(set) var stopped: [SenseItem] = []

    func configuredRetention(_ key: String) -> Int? { nil }
    func authorization(_ item: SenseItem) async -> SenseAuthorization { authorizationValue }
    func requestAuthorization(_ item: SenseItem) async -> SenseAuthorization { authorizationValue }
    func alwaysAllowed(_ item: SenseItem) -> Bool? { nil }
    func requestAlways(_ item: SenseItem) async -> Bool { false }
    func start(_ item: SenseItem) { started.append(item) }
    func stop(_ item: SenseItem) async { stopped.append(item) }
    func status() async throws -> PerceptionStatusSnapshot { throw SensesGatewayError.notInstalled }
    func day(_ item: SenseItem) async throws -> PerceptionDaySnapshot { throw SensesGatewayError.notInstalled }
    func setSense(_ sense: String, enabled: Bool, revision: Int, reason: String) async throws {}
    func setRetention(key: String, days: Int?, revision: Int, reason: String) async throws {}
    func deleteRecords(_ item: SenseItem, reason: String) async throws -> PerceptionDeleteResult { throw SensesGatewayError.notInstalled }
    func mirrorCount(_ item: SenseItem) async -> Int? { nil }
    func clearMirror(_ item: SenseItem) async throws {}
}

@MainActor
struct SensesReconcileTests {
    private func makeModel(on item: SenseItem, service: RecordingSensesService) throws -> SensesModel {
        let store = MemoryLocalStore()
        try SenseSwitches(store: store).update(item) { $0.on = true }
        return SensesModel(service: service, store: store)
    }

    @Test func refreshStopsAnItemWhoseSystemAccessWasTakenAway() async throws {
        let service = RecordingSensesService()
        let model = try makeModel(on: .clipboard, service: service)
        await model.refresh()
        #expect(service.started.contains(.clipboard))
        #expect(!service.stopped.contains(.clipboard))
        service.authorizationValue = .denied
        await model.refresh()
        #expect(service.stopped.contains(.clipboard))
    }

    @Test func refreshNeverStartsAnItemThatIsSwitchedOff() async throws {
        let service = RecordingSensesService()
        let model = try makeModel(on: .clipboard, service: service)
        await model.refresh()
        #expect(service.started == [.clipboard])
        #expect(service.stopped.contains(.location))
    }
}
