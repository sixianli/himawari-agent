import Foundation
import HimawariCore
import Observation

@MainActor
@Observable
final class VaultModel {
    enum Phase: Equatable {
        case loading
        case ready
        case keyMissing
        case manifestInvalid
        case failed
    }

    private(set) var phase: Phase = .loading
    private(set) var items: [VaultStoredItem] = []
    private(set) var pending: [VaultPendingRequest] = []
    private(set) var lastUse: [String: String] = [:]
    private(set) var usage: [String: [VaultUsageEntry]] = [:]
    private(set) var usernames: [String: String] = [:]
    @ObservationIgnored private let session: VaultSession

    init(session: VaultSession) {
        self.session = session
    }

    func load() async {
        do {
            let state = try await session.load()
            items = state.items
            pending = state.pending
            usernames = Dictionary(uniqueKeysWithValues: state.items.compactMap { item in
                (try? session.username(of: item)).flatMap { $0 }.map { (item.id, $0) }
            })
            phase = .ready
            let recent = try await session.usage(itemId: nil)
            var latest: [String: String] = [:]
            for entry in recent where latest[entry.itemId] == nil { latest[entry.itemId] = entry.at }
            lastUse = latest
        } catch VaultSessionError.keyMissing {
            phase = .keyMissing
        } catch VaultSessionError.manifestInvalid, VaultSessionError.manifestRolledBack {
            phase = .manifestInvalid
        } catch {
            if phase == .loading { phase = .failed }
        }
    }

    func loadUsage(_ itemId: String) async {
        if let entries = try? await session.usage(itemId: itemId) { usage[itemId] = entries }
    }

    func item(_ id: String) -> VaultStoredItem? { items.first { $0.id == id } }

    func request(_ id: String) -> VaultPendingRequest? { pending.first { $0.id == id } }

    func add(_ values: VaultItemValues) async throws {
        try await run { try await self.session.add(values) }
    }

    func replace(_ itemId: String, field: VaultItemField, with value: String) async throws {
        try await run { try await self.session.replace(itemId: itemId, field: field, with: value) }
    }

    func delete(_ itemId: String) async throws {
        try await run { try await self.session.delete(itemId: itemId) }
    }

    func rotate() async throws {
        try await run { try await self.session.rotate() }
    }

    func approve(_ requestId: String, reason: String) async throws {
        try await run { try await self.session.approve(requestId: requestId, reason: reason) }
    }

    func deny(_ request: VaultPendingRequest) async throws {
        try await run { try await self.session.deny(request) }
    }

    private func run(_ action: @escaping () async throws -> Void) async throws {
        do {
            try await action()
            await load()
        } catch {
            await load()
            throw error
        }
    }
}

final class DefaultsVaultManifestFloor: VaultManifestFloor, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, deviceId: String) {
        self.defaults = defaults
        key = "himawari.vault.manifest-floor.\(deviceId)"
    }

    func highest() -> Int { defaults.integer(forKey: key) }

    func record(_ version: Int) {
        if version > highest() { defaults.set(version, forKey: key) }
    }
}
