import Foundation
import Testing
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import HimawariCore

final class MemoryVaultKeys: VaultMasterKeyStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var slots: [VaultKeySlot: Data] = [:]
    var failNextWriteTo: VaultKeySlot?

    func read(_ slot: VaultKeySlot) throws -> Data? { lock.withLock { slots[slot] } }

    func write(_ slot: VaultKeySlot, _ key: Data) throws {
        try lock.withLock {
            if failNextWriteTo == slot {
                failNextWriteTo = nil
                throw VaultMasterKeyError.keychain(-1)
            }
            slots[slot] = key
        }
    }

    func remove(_ slot: VaultKeySlot) throws { lock.withLock { slots[slot] = nil } }
}

final class MemoryFloor: VaultManifestFloor, @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func highest() -> Int { lock.withLock { value } }
    func record(_ version: Int) { lock.withLock { value = max(value, version) } }
}

final class FakeVaultServer: VaultTransport, @unchecked Sendable {
    private let lock = NSLock()
    var manifest: VaultManifestSignature?
    var items: [String: VaultSealedItem] = [:]
    var pending: [VaultPendingRequest] = []
    var approvals: [VaultApproval] = []
    var denials: [String] = []
    var replayManifest: (VaultManifestSignature, [String: VaultSealedItem])?

    func snapshot() async throws -> VaultSnapshot {
        lock.withLock {
            let (manifest, items) = replayManifest ?? (self.manifest, self.items)
            return VaultSnapshot(
                manifest: manifest,
                items: items.values.map { VaultStoredItem(id: $0.id, name: $0.name, kind: $0.kind, origins: $0.origins, fields: $0.fields, version: $0.version, backgroundAllowed: $0.backgroundAllowed, wrappedKey: $0.wrappedKey, ciphertexts: $0.ciphertexts, updatedAt: "2026-11-25T00:00:00.000Z") },
                pending: pending
            )
        }
    }

    func usage(itemId: String?) async throws -> [VaultUsageEntry] { [] }

    func change(_ change: VaultChange) async throws -> VaultChangeOutcome {
        lock.withLock {
            guard change.expectedManifestVersion == (manifest?.version ?? 0), change.manifest.version == change.expectedManifestVersion + 1 else { return .conflict }
            for item in change.upserts {
                if let old = items[item.id], old.version >= item.version { return .conflict }
                items[item.id] = item
            }
            for id in change.deletes { items[id] = nil }
            manifest = change.manifest
            return .applied(change.manifest)
        }
    }

    func approve(_ approval: VaultApproval, reason: String) async throws -> VaultDecisionOutcome {
        lock.withLock {
            approvals.append(approval)
            return .recorded
        }
    }

    func deny(requestId: String, nonce: String) async throws -> VaultDecisionOutcome {
        lock.withLock {
            denials.append(requestId)
            return .recorded
        }
    }
}

@Suite struct VaultSessionTests {
    private let login = VaultItemValues(name: "招商银行网银", kind: .login, origins: ["https://ebank.example.com"], values: ["username": "andy.li", "password": "first"], backgroundAllowed: false)

    private func session(_ server: FakeVaultServer, _ keys: MemoryVaultKeys = MemoryVaultKeys(), _ floor: MemoryFloor = MemoryFloor()) -> VaultSession {
        VaultSession(transport: server, keys: keys, floor: floor, deviceId: "dev_AAAAAAAAAAAAAAAAAAAAAA", now: { Date(timeIntervalSince1970: 59) })
    }

    private func request(for item: VaultStoredItem, origin: String, ephemeral: P256.KeyAgreement.PrivateKey) -> VaultPendingRequest {
        VaultPendingRequest(id: "vr_AAAAAAAAAAAAAAAAAAAAAA", nonce: String(repeating: "n", count: 43), itemIds: [item.id], itemVersions: [item.version], origin: origin, pageVersion: nil, ephemeralPublicKey: ephemeral.publicKey.x963Representation.base64EncodedString(), expiresAt: "2026-11-25T00:02:00.000Z", createdAt: "2026-11-25T00:00:00.000Z", purpose: "看余额")
    }

    @Test func firstItemCreatesTheMasterKeyAndASignedManifest() async throws {
        let server = FakeVaultServer()
        let keys = MemoryVaultKeys()
        let vault = session(server, keys)
        try await vault.add(login)
        let state = try await vault.load()
        #expect(state.manifestVersion == 1)
        #expect(state.items.map(\.name) == ["招商银行网银"])
        #expect(try keys.read(.current) != nil)
        #expect(try vault.username(of: try #require(state.items.first)) == "andy.li")
    }

    @Test func replacingASecretBumpsTheVersionAndKeepsTheOtherFields() async throws {
        let server = FakeVaultServer()
        let keys = MemoryVaultKeys()
        let vault = session(server, keys)
        try await vault.add(login)
        let id = try #require(try await vault.load().items.first?.id)
        try await vault.replace(itemId: id, field: .secret, with: "second")
        try await vault.setBackgroundAllowed(itemId: id, true)
        let item = try #require(try await vault.load().items.first)
        #expect(item.version == 3)
        #expect(item.backgroundAllowed)
        let opened = try VaultKeyring(masterKey: try #require(try keys.read(.current))).open(item.sealed)
        #expect(opened.values == ["username": "andy.li", "password": "second"])
    }

    @Test func refusesAServerThatEditsTheListOrRollsItBack() async throws {
        let server = FakeVaultServer()
        let keys = MemoryVaultKeys()
        let floor = MemoryFloor()
        let vault = session(server, keys, floor)
        try await vault.add(login)
        let old = (try #require(server.manifest), server.items)
        try await vault.add(VaultItemValues(name: "OpenAI", kind: .apiKey, origins: ["https://api.openai.com"], values: ["api_key": "sk"], backgroundAllowed: false))
        _ = try await vault.load()
        server.replayManifest = old
        await #expect(throws: VaultSessionError.manifestRolledBack) { _ = try await vault.load() }
        server.replayManifest = nil
        let id = try #require(server.items.values.first { $0.name == "OpenAI" }?.id)
        let tampered = try #require(server.items[id])
        server.items[id] = VaultSealedItem(id: id, name: "招商银行网银", kind: tampered.kind, origins: ["https://evil.example.com"], fields: tampered.fields, version: tampered.version, backgroundAllowed: true, wrappedKey: tampered.wrappedKey, ciphertexts: tampered.ciphertexts)
        await #expect(throws: VaultSessionError.manifestInvalid) { _ = try await vault.load() }
    }

    @Test func approvalSealsTheItemKeyForTheEphemeralKeyAndRefusesAnotherSite() async throws {
        let server = FakeVaultServer()
        let keys = MemoryVaultKeys()
        let vault = session(server, keys)
        try await vault.add(login)
        let item = try #require(try await vault.load().items.first)
        let ephemeral = P256.KeyAgreement.PrivateKey()
        server.pending = [request(for: item, origin: "https://ebank.example.com", ephemeral: ephemeral)]
        try await vault.approve(requestId: "vr_AAAAAAAAAAAAAAAAAAAAAA", reason: "批准")
        let approval = try #require(server.approvals.first)
        #expect(approval.deviceId == "dev_AAAAAAAAAAAAAAAAAAAAAA")
        let release = try #require(approval.sealed.first)
        var recipient = try HPKE.Recipient(privateKey: ephemeral, ciphersuite: .P256_SHA256_AES_GCM_256, info: VaultContract.releaseInfo, encapsulatedKey: try #require(Data(base64Encoded: release.enc)))
        let plain = try recipient.open(try #require(Data(base64Encoded: release.ciphertext)), authenticating: VaultContract.releaseAAD(requestId: approval.requestId, itemId: item.id, version: item.version))
        let object = try #require(try JSONSerialization.jsonObject(with: plain) as? [String: String])
        #expect(Set(object.keys) == ["itemKey"])

        server.pending = [request(for: item, origin: "https://evil.example.com", ephemeral: ephemeral)]
        await #expect(throws: VaultSessionError.requestMismatch) { try await vault.approve(requestId: "vr_AAAAAAAAAAAAAAAAAAAAAA", reason: "批准") }
        #expect(server.approvals.count == 1)
    }

    @Test func aRequestForAnOlderVersionIsNotShown() async throws {
        let server = FakeVaultServer()
        let vault = session(server)
        try await vault.add(login)
        let item = try #require(try await vault.load().items.first)
        server.pending = [request(for: item, origin: "https://ebank.example.com", ephemeral: P256.KeyAgreement.PrivateKey())]
        try await vault.replace(itemId: item.id, field: .secret, with: "second")
        #expect(try await vault.load().pending.isEmpty)
        await #expect(throws: VaultSessionError.requestGone) { try await vault.approve(requestId: "vr_AAAAAAAAAAAAAAAAAAAAAA", reason: "批准") }
    }

    @Test func rotationReencryptsEverythingAndSurvivesALostKeyWrite() async throws {
        let server = FakeVaultServer()
        let keys = MemoryVaultKeys()
        let vault = session(server, keys)
        try await vault.add(login)
        let before = try #require(try keys.read(.current))
        keys.failNextWriteTo = .current
        await #expect(throws: VaultMasterKeyError.self) { try await vault.rotate() }
        #expect(try keys.read(.current) == before)
        let state = try await vault.load()
        let after = try #require(try keys.read(.current))
        #expect(after != before)
        #expect(try keys.read(.next) == nil)
        #expect(state.items.first?.version == 2)
        #expect(try VaultKeyring(masterKey: after).open(try #require(state.items.first).sealed).values["password"] == "first")
        let rotated = try #require(state.items.first).sealed
        #expect(throws: (any Error).self) { _ = try VaultKeyring(masterKey: before).itemKey(rotated) }
    }

    @Test func aMissingKeyWithStoredItemsIsReportedNotReplaced() async throws {
        let server = FakeVaultServer()
        let keys = MemoryVaultKeys()
        let vault = session(server, keys)
        try await vault.add(login)
        try keys.remove(.current)
        await #expect(throws: VaultSessionError.keyMissing) { _ = try await vault.load() }
        await #expect(throws: VaultSessionError.keyMissing) { try await vault.add(login) }
        #expect(try keys.read(.current) == nil)
    }
}
