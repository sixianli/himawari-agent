import Foundation
import HimawariCore
import Observation

public enum SenseDayLoad: Equatable {
    case loading
    case loaded(PerceptionDaySnapshot)
    case failed
}

public enum SenseScreen: Equatable {
    case intro
    case denied
    case detail
}

@MainActor
@Observable
public final class SensesModel {
    public private(set) var authorizations: [SenseItem: SenseAuthorization] = [:]
    public private(set) var switchStates: [SenseItem: SenseSwitchState] = [:]
    public private(set) var status: PerceptionStatusSnapshot?
    public private(set) var days: [SenseItem: SenseDayLoad] = [:]
    public private(set) var mirrorCounts: [SenseItem: Int] = [:]
    public private(set) var always: [SenseItem: Bool] = [:]
    public private(set) var working: SenseItem?
    public var notice: String?

    @ObservationIgnored let service: SensesService
    @ObservationIgnored private let switches: SenseSwitches

    public init(service: SensesService, store: LocalStore) {
        self.service = service
        switches = SenseSwitches(store: store)
        for item in SenseItem.allCases { switchStates[item] = switches.state(item) }
    }

    public var items: [SenseItem] { SenseItem.allCases }

    public func state(_ item: SenseItem) -> SenseState {
        SenseStateRule.state(
            item: item,
            switchedOn: switchStates[item]?.on ?? false,
            authorization: authorizations[item] ?? .notAsked,
            server: service.server
        )
    }

    public func screen(_ item: SenseItem) -> SenseScreen {
        switch authorizations[item] ?? .notAsked {
        case .denied, .restricted, .unavailable: return .denied
        case .notAsked: return switchStates[item]?.introSeen == true ? .detail : .intro
        case .allowed, .limited:
            let switchState = switchStates[item] ?? SenseSwitchState()
            return switchState.on || switchState.introSeen ? .detail : .intro
        }
    }

    public var canDelete: Bool { service.operations.contains(SenseOperation.deleteRecords) }

    public func retention(_ item: SenseItem) -> PerceptionRetentionSetting? {
        status?.retention(item.retentionKey)
    }

    public func configuredRetention(_ item: SenseItem) -> Int? {
        item.retentionKey.flatMap { service.configuredRetention($0) }
    }

    public func refresh() async {
        for item in items {
            authorizations[item] = await service.authorization(item)
            always[item] = service.alwaysAllowed(item)
        }
        await reloadStatus()
        for item in items where item.isMirror {
            if let count = await service.mirrorCount(item) { mirrorCounts[item] = count }
        }
        await resume()
    }

    public func resume() async {
        for item in items { await reconcile(item) }
    }

    private func reconcile(_ item: SenseItem) async {
        switch state(item) {
        case .on:
            if service.server != nil { service.start(item) }
        case .off, .systemDenied, .serverUnsupported:
            await service.stop(item)
        case .serverPaused:
            break
        }
    }

    public func suspend() {
        let service = service
        Task {
            for item in SenseItem.allCases { await service.stop(item) }
        }
    }

    private func reloadStatus() async {
        status = try? await service.status()
    }

    public func loadDay(_ item: SenseItem) async {
        guard !item.isMirror else {
            if let count = await service.mirrorCount(item) { mirrorCounts[item] = count }
            return
        }
        if days[item] == nil { days[item] = .loading }
        do {
            days[item] = .loaded(try await service.day(item))
        } catch {
            days[item] = .failed
        }
    }

    public func turnOn(_ item: SenseItem) async {
        guard working == nil else { return }
        working = item
        defer { working = nil }
        var authorization = await service.authorization(item)
        if authorization == .notAsked { authorization = await service.requestAuthorization(item) }
        update(item) { $0.introSeen = true }
        authorizations[item] = authorization
        always[item] = service.alwaysAllowed(item)
        guard authorization == .allowed || authorization == .limited else { return }
        if let sense = item.serverSense, let server = service.server, !server.allows(item) {
            if status == nil { await reloadStatus() }
            guard let status else {
                notice = L.text("detail.failed")
                return
            }
            do {
                try await service.setSense(sense, enabled: true, revision: status.revision, reason: L.format("intro.serverReason", item.name))
            } catch SensesGatewayError.confirmationCancelled {
                return
            } catch {
                notice = L.text("detail.failed")
                return
            }
            await service.refreshServer()
            await reloadStatus()
        }
        update(item) { $0.on = true }
        await reconcile(item)
        await loadDay(item)
    }

    public func turnOff(_ item: SenseItem) async {
        update(item) { $0.on = false }
        await service.stop(item)
    }

    public func setSwitch(_ item: SenseItem, on: Bool) async {
        if on { await turnOn(item) } else { await turnOff(item) }
    }

    public func requestAlways(_ item: SenseItem) async {
        update(item) { $0.askedAlways = true }
        always[item] = await service.requestAlways(item)
    }

    public func setRetention(_ item: SenseItem, days: Int) async {
        guard let key = item.retentionKey, let status else { return }
        do {
            try await service.setRetention(key: key, days: days, revision: status.revision, reason: L.text("detail.retentionReason"))
            await reloadStatus()
        } catch SensesGatewayError.confirmationCancelled {
        } catch {
            notice = L.text("detail.failed")
        }
    }

    public func deleteAll(_ item: SenseItem) async {
        guard canDelete, working == nil else { return }
        working = item
        defer { working = nil }
        do {
            let result = try await service.deleteRecords(item, reason: L.format("detail.deleteAll", item.name))
            notice = L.format("detail.deleted", result.deleted.records + result.deleted.trackPoints)
            await loadDay(item)
            await reloadStatus()
        } catch SensesGatewayError.confirmationCancelled {
        } catch {
            notice = L.text("detail.failed")
        }
    }

    public func turnOffAndClear(_ item: SenseItem) async {
        guard item.isMirror, working == nil else { return }
        working = item
        defer { working = nil }
        update(item) { $0.on = false }
        await service.stop(item)
        do {
            try await service.clearMirror(item)
            mirrorCounts[item] = 0
        } catch {
            notice = L.text("detail.failed")
        }
    }

    private func update(_ item: SenseItem, _ change: (inout SenseSwitchState) -> Void) {
        try? switches.update(item, change)
        switchStates[item] = switches.state(item)
    }
}
