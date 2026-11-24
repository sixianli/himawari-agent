import Foundation

public protocol VaultTransport: Sendable {
    func snapshot() async throws -> VaultSnapshot
    func usage(itemId: String?) async throws -> [VaultUsageEntry]
    func change(_ change: VaultChange) async throws -> VaultChangeOutcome
    func approve(_ approval: VaultApproval, reason: String) async throws -> VaultDecisionOutcome
    func deny(requestId: String, nonce: String) async throws -> VaultDecisionOutcome
}

public protocol VaultManifestFloor: Sendable {
    func highest() -> Int
    func record(_ version: Int)
}

public struct DeviceVaultTransport: VaultTransport {
    public let api: DeviceAPI
    public let confirmKey: DeviceKeySigner

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner) {
        self.api = api
        self.confirmKey = confirmKey
    }

    public func snapshot() async throws -> VaultSnapshot { try await api.vaultSnapshot() }
    public func usage(itemId: String?) async throws -> [VaultUsageEntry] { try await api.vaultUsage(itemId: itemId) }
    public func change(_ change: VaultChange) async throws -> VaultChangeOutcome { try await api.changeVault(change) }
    public func approve(_ approval: VaultApproval, reason: String) async throws -> VaultDecisionOutcome {
        try await api.approveVault(approval, confirm: confirmKey, reason: reason)
    }
    public func deny(requestId: String, nonce: String) async throws -> VaultDecisionOutcome {
        try await api.denyVault(requestId: requestId, nonce: nonce)
    }
}

public enum VaultSessionError: Error, Equatable, Sendable {
    case keyMissing
    case manifestInvalid
    case manifestRolledBack
    case conflict
    case unknownItem
    case requestMismatch
    case requestGone
    case invalidValue
}

public struct VaultVerifiedState: Sendable, Equatable {
    public let manifestVersion: Int
    public let items: [VaultStoredItem]
    public let pending: [VaultPendingRequest]
}

public enum VaultItemField: Sendable, Hashable {
    case secret
    case username
    case totp
}

public final class VaultSession: Sendable {
    private let transport: VaultTransport
    private let keys: VaultMasterKeyStoring
    private let floor: VaultManifestFloor
    private let deviceId: String
    private let now: @Sendable () -> Date

    public init(transport: VaultTransport, keys: VaultMasterKeyStoring, floor: VaultManifestFloor, deviceId: String, now: @escaping @Sendable () -> Date = Date.init) {
        self.transport = transport
        self.keys = keys
        self.floor = floor
        self.deviceId = deviceId
        self.now = now
    }

    private func keyring(_ slot: VaultKeySlot) throws -> VaultKeyring? {
        try keys.read(slot).map(VaultKeyring.init(masterKey:))
    }

    private func verified(_ snapshot: VaultSnapshot) throws -> (VaultVerifiedState, VaultKeyring?) {
        let sealed = snapshot.items.map(\.sealed)
        guard let manifest = snapshot.manifest else {
            guard snapshot.items.isEmpty else { throw VaultSessionError.manifestInvalid }
            guard floor.highest() == 0 else { throw VaultSessionError.manifestRolledBack }
            return (VaultVerifiedState(manifestVersion: 0, items: [], pending: []), try keyring(.current))
        }
        var keyring = try keyring(.current)
        if keyring.map({ !$0.manifestValid(manifest, items: sealed) }) ?? true,
           let nextKey = try keys.read(.next),
           let next = try? VaultKeyring(masterKey: nextKey),
           next.manifestValid(manifest, items: sealed) {
            try keys.write(.current, nextKey)
            try keys.remove(.next)
            keyring = next
        }
        guard let keyring else { throw VaultSessionError.keyMissing }
        guard keyring.manifestValid(manifest, items: sealed) else { throw VaultSessionError.manifestInvalid }
        guard manifest.version >= floor.highest() else { throw VaultSessionError.manifestRolledBack }
        floor.record(manifest.version)
        let known = Dictionary(snapshot.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let pending = snapshot.pending.filter { request in
            request.itemIds.count == request.itemVersions.count && zip(request.itemIds, request.itemVersions).allSatisfy { known[$0.0]?.version == $0.1 }
        }
        return (VaultVerifiedState(manifestVersion: manifest.version, items: snapshot.items.sorted { ($0.name, $0.id) < ($1.name, $1.id) }, pending: pending), keyring)
    }

    public func load() async throws -> VaultVerifiedState {
        try verified(try await transport.snapshot()).0
    }

    public func usage(itemId: String?) async throws -> [VaultUsageEntry] {
        try await transport.usage(itemId: itemId)
    }

    public func username(of item: VaultStoredItem) throws -> String? {
        guard item.fields.contains("username"), let keyring = try keyring(.current) else { return nil }
        return try keyring.open(item.sealed).values["username"]
    }

    private func submit(_ state: VaultVerifiedState, keyring: VaultKeyring, items: [VaultSealedItem], upserts: [VaultSealedItem], deletes: [String], rotation: Bool) async throws {
        let manifest = keyring.manifestSignature(version: state.manifestVersion + 1, items: items)
        let change = VaultChange(expectedManifestVersion: state.manifestVersion, manifest: manifest, upserts: upserts, deletes: deletes, rotation: rotation)
        switch try await transport.change(change) {
        case .applied(let applied):
            floor.record(applied.version)
        case .conflict:
            throw VaultSessionError.conflict
        }
    }

    public func add(_ values: VaultItemValues) async throws {
        let (state, existing) = try verified(try await transport.snapshot())
        let keyring: VaultKeyring
        if let existing {
            keyring = existing
        } else {
            guard state.manifestVersion == 0 else { throw VaultSessionError.keyMissing }
            let fresh = VaultKeyring.newMasterKey()
            try keys.write(.current, fresh)
            keyring = try VaultKeyring(masterKey: fresh)
        }
        let item: VaultSealedItem
        do { item = try keyring.seal(id: VaultContract.newItemId(), item: values, version: 1) } catch { throw VaultSessionError.invalidValue }
        try await submit(state, keyring: keyring, items: state.items.map(\.sealed) + [item], upserts: [item], deletes: [], rotation: false)
    }

    public func update(itemId: String, change: (inout VaultItemValues) -> Void) async throws {
        let (state, keyring) = try verified(try await transport.snapshot())
        guard let keyring else { throw VaultSessionError.keyMissing }
        guard let stored = state.items.first(where: { $0.id == itemId }) else { throw VaultSessionError.unknownItem }
        var values = try keyring.open(stored.sealed)
        change(&values)
        let item: VaultSealedItem
        do { item = try keyring.seal(id: itemId, item: values, version: stored.version + 1) } catch { throw VaultSessionError.invalidValue }
        let items = state.items.map { $0.id == itemId ? item : $0.sealed }
        try await submit(state, keyring: keyring, items: items, upserts: [item], deletes: [], rotation: false)
    }

    public func replace(itemId: String, field: VaultItemField, with value: String) async throws {
        guard !value.isEmpty else { throw VaultSessionError.invalidValue }
        try await update(itemId: itemId) { values in
            switch field {
            case .secret: values.values[values.kind == .apiKey ? "api_key" : "password"] = value
            case .username: values.values["username"] = value
            case .totp: values.values["totp"] = value
            }
        }
    }

    public func setBackgroundAllowed(itemId: String, _ allowed: Bool) async throws {
        try await update(itemId: itemId) { $0.backgroundAllowed = allowed }
    }

    public func delete(itemId: String) async throws {
        let (state, keyring) = try verified(try await transport.snapshot())
        guard let keyring else { throw VaultSessionError.keyMissing }
        guard state.items.contains(where: { $0.id == itemId }) else { throw VaultSessionError.unknownItem }
        try await submit(state, keyring: keyring, items: state.items.filter { $0.id != itemId }.map(\.sealed), upserts: [], deletes: [itemId], rotation: false)
    }

    public func rotate() async throws {
        let (state, current) = try verified(try await transport.snapshot())
        guard let current else { throw VaultSessionError.keyMissing }
        let fresh = VaultKeyring.newMasterKey()
        let next = try VaultKeyring(masterKey: fresh)
        let upserts = try state.items.map { stored in
            try next.seal(id: stored.id, item: try current.open(stored.sealed), version: stored.version + 1)
        }
        try keys.write(.next, fresh)
        try await submit(state, keyring: next, items: upserts, upserts: upserts, deletes: [], rotation: true)
        try keys.write(.current, fresh)
        try keys.remove(.next)
    }

    public func approve(requestId: String, reason: String) async throws {
        let (state, keyring) = try verified(try await transport.snapshot())
        guard let keyring else { throw VaultSessionError.keyMissing }
        guard let request = state.pending.first(where: { $0.id == requestId }) else { throw VaultSessionError.requestGone }
        let sealed: [VaultSealedRelease]
        do { sealed = try keyring.release(request: request, items: state.items.map(\.sealed), now: now()) } catch { throw VaultSessionError.requestMismatch }
        if try await transport.approve(VaultApproval(request: request, deviceId: deviceId, sealed: sealed), reason: reason) == .gone {
            throw VaultSessionError.requestGone
        }
    }

    public func deny(_ request: VaultPendingRequest) async throws {
        _ = try await transport.deny(requestId: request.id, nonce: request.nonce)
    }
}
