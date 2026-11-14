import Foundation
import Testing
@testable import HimawariCore

@Suite struct PairingProblemTests {
    @Test func mapsServerPairingErrors() {
        #expect(PairingProblem.from(DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED")) == .codeExpired(ttlSeconds: nil))
        #expect(PairingProblem.from(DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED", pairingCodeTtlSeconds: 600)) == .codeExpired(ttlSeconds: 600))
        #expect(PairingProblem.from(DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED", pairingCodeTtlSeconds: 0)) == .codeExpired(ttlSeconds: nil))
        #expect(PairingProblem.from(DeviceAPIError.server(status: 409, code: "DEVICE_PAIRING_CODE_USED")) == .codeUsed)
        #expect(PairingProblem.from(DeviceAPIError.server(status: 403, code: "DEVICE_REVOKED")) == .removed)
        #expect(PairingProblem.from(DeviceAPIError.server(status: 404, code: "DEVICE_PAIRING_CODE_INVALID")) == .codeInvalid)
        #expect(PairingProblem.from(DeviceAPIError.server(status: 502, code: nil)) == .unreachable)
        #expect(PairingProblem.from(URLError(.notConnectedToInternet)) == .unreachable)
        #expect(PairingProblem.from(PairingInvitation.ParseError.notAPairingCode) == .unreadableCode)
        #expect(PairingProblem.from(DeviceKeyError.secureEnclaveUnavailable) == .keysUnavailable)
    }

    @Test func recordRoundTripsWithoutLosingTheNumber() throws {
        let record = PairingRecord(origin: URL(string: "https://a.test")!, deviceId: "dev_x", access: ServiceAccessToken(clientId: "i", secret: "s"), status: .pending, pairingNumber: "012345")
        let decoded = try JSONDecoder().decode(PairingRecord.self, from: JSONEncoder().encode(record))
        #expect(decoded == record)
    }
}

@Suite struct DeviceConfigurationTests {
    @Test func readsStreamConnectionsWhenTheServerSendsIt() throws {
        let base = #"{"heartbeatSeconds":15,"connectionMaxSeconds":300,"signatureToleranceSeconds":60,"limits":[]"#
        let with = try JSONDecoder().decode(DeviceConfiguration.self, from: Data((base + #","streamConnections":4}"#).utf8))
        let without = try JSONDecoder().decode(DeviceConfiguration.self, from: Data((base + "}").utf8))
        #expect(with.streamConnections == 4)
        #expect(without.streamConnections == nil)
    }
}

@Suite struct PairingDecisionTests {
    @Test func restoreNeverForgetsWhenSomethingIsOnlyUnreadable() {
        #expect(RestoreDecision.decide(presence: [.present, .present, .present], recordDecodes: true) == .use)
        #expect(RestoreDecision.decide(presence: [.present, .present, .present], recordDecodes: false) == .unreadable)
        #expect(RestoreDecision.decide(presence: [.present, .unreadable, .absent], recordDecodes: false) == .unreadable)
        #expect(RestoreDecision.decide(presence: [.present, .absent, .present], recordDecodes: true) == .forget)
        #expect(RestoreDecision.decide(presence: [.absent, .absent, .absent], recordDecodes: false) == .forget)
    }

    @Test func aRefusedPairingLeavesNothingBehindButAnUnknownOutcomeKeepsTheKeys() {
        #expect(!PairingAttempt.mayHavePaired(DeviceAPIError.server(status: 403, code: "DEVICE_REVOKED")))
        #expect(!PairingAttempt.mayHavePaired(DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED")))
        #expect(!PairingAttempt.mayHavePaired(DeviceKeyError.secureEnclaveUnavailable))
        #expect(PairingAttempt.mayHavePaired(DeviceAPIError.server(status: 502, code: nil)))
        #expect(PairingAttempt.mayHavePaired(DeviceAPIError.server(status: 429, code: nil)))
        #expect(PairingAttempt.mayHavePaired(URLError(.timedOut)))
    }

    @Test func theExecutionStreamNeedsRoomForTwoConnections() {
        #expect(ExecutionStreamPolicy.allowed(streamConnections: nil))
        #expect(ExecutionStreamPolicy.allowed(streamConnections: 4))
        #expect(ExecutionStreamPolicy.allowed(streamConnections: 2))
        #expect(!ExecutionStreamPolicy.allowed(streamConnections: 1))
        #expect(!ExecutionStreamPolicy.allowed(streamConnections: 0))
    }

    @Test func aStoreLeftByAnotherPairingIsEmptiedBeforeUse() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("claim-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try FileLocalStore(directory: directory)
        try store.write("outbox", Data("old".utf8))
        try store.claim(for: "dev_a")
        #expect(store.read("outbox") == nil)
        try store.write("outbox", Data("mine".utf8))
        try store.claim(for: "dev_a")
        #expect(store.read("outbox") == Data("mine".utf8))
        try store.claim(for: "dev_b")
        #expect(store.read("outbox") == nil)
    }

    @Test func emptyingAStoreThatCannotBeListedFails() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gone-\(UUID().uuidString)", isDirectory: true)
        let store = try FileLocalStore(directory: directory)
        try FileManager.default.removeItem(at: directory)
        #expect(throws: (any Error).self) { try store.removeAll() }
    }

    @Test func anOwnerMarkThatCannotBeReadLeavesTheStoreAlone() throws {
        let store = UnreadableMarkStore()
        try store.write("outbox", Data("unsent".utf8))
        #expect(throws: LocalStoreError.unreadable("owner")) { try store.claim(for: "dev_a") }
        #expect(store.read("outbox") == Data("unsent".utf8))
    }

    @Test func aRetiredStoreIsEmptyAndTakesNoLateWrites() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("retire-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try FileLocalStore(directory: directory)
        try store.write("threads-cache.json", Data("old".utf8))
        try store.retire()
        #expect(store.read("threads-cache.json") == nil)
        #expect(throws: LocalStoreError.retired) { try store.write("threads-cache.json", Data("late".utf8)) }
        #expect(store.read("threads-cache.json") == nil)
        let next = try FileLocalStore(directory: directory)
        try next.claim(for: "dev_b")
        try next.write("outbox.json", Data("new".utf8))
        #expect(next.read("outbox.json") == Data("new".utf8))
    }

    @Test func aRemovedDeviceOnlyClaimsItsDataIsGoneWhenTheStoreWasEmptied() {
        #expect(ForgetOutcome.problem(wanted: .removed, storeEmptied: true) == .removed)
        #expect(ForgetOutcome.problem(wanted: .removed, storeEmptied: false) == nil)
        #expect(ForgetOutcome.problem(wanted: nil, storeEmptied: false) == nil)
    }

    @Test func aRevokedDeviceIsToldApartFromANetworkFailure() {
        #expect(DeviceAPIError.server(status: 403, code: "DEVICE_REVOKED").isRevoked)
        #expect(!DeviceAPIError.server(status: 403, code: "FORBIDDEN").isRevoked)
        #expect(!DeviceAPIError.server(status: 503, code: nil).isRevoked)
    }
}

private final class UnreadableMarkStore: LocalStore, @unchecked Sendable {
    private let inner = MemoryLocalStore()

    func read(_ name: String) -> Data? {
        name == "owner" ? nil : inner.read(name)
    }

    func contains(_ name: String) -> Bool {
        name == "owner" || inner.contains(name)
    }

    func write(_ name: String, _ data: Data?) throws {
        try inner.write(name, data)
    }

    func removeAll() throws {
        try inner.removeAll()
    }
}
