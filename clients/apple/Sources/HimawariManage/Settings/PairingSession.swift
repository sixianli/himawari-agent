import Foundation
import HimawariCore
import Observation

@MainActor
@Observable
public final class PairingSession {
    public private(set) var stage: PairingStage = .starting

    @ObservationIgnored private let store: SettingsStore
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var knownPending: Set<String> = []
    @ObservationIgnored private let fixed: Bool

    public init(store: SettingsStore, pollInterval: Duration = .seconds(2), now: @escaping () -> Date = Date.init) {
        self.store = store
        self.pollInterval = pollInterval
        self.now = now
        fixed = false
    }

    init(store: SettingsStore, fixed stage: PairingStage) {
        self.store = store
        pollInterval = .seconds(2)
        now = Date.init
        fixed = true
        self.stage = stage
    }

    public func run(reason: String) async {
        guard !fixed else { return }
        stage = .starting
        guard let identity = store.identity else {
            stage = .failed
            return
        }
        do {
            knownPending = Set(try await store.loadDevices().devices.filter { $0.status == "pending" }.map(\.id))
            let code = PairingInvitation.newCode()
            _ = try await store.gateway.command(
                .v2,
                "device.pairing.start",
                payload: ["pairingCode": .string(code)],
                options: ManageCommandOptions(confirmReason: reason)
            )
            let listed = try await store.loadDevices()
            guard let pairing = listed.pairing, let expiresAt = Timestamp.parse(pairing.expiresAt) else {
                stage = .failed
                return
            }
            let invitation = PairingInvitation(origin: identity.origin, code: code, access: pairing.access ?? identity.access)
            let minutes = Int((expiresAt.timeIntervalSince(now()) / 60).rounded())
            stage = .showing(link: invitation.link, expiresAt: expiresAt)
            await watch(until: expiresAt, minutes: minutes >= 1 ? minutes : nil)
        } catch {
            stage = .failed
        }
    }

    public func confirm(_ device: PairedDevice, reason: String) async throws {
        _ = try await store.gateway.command(
            .v2,
            "device.pairing.confirm",
            payload: ["deviceId": .string(device.id), "expectedRevision": .number(Double(device.revision))],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await store.reloadDevices()
    }

    public func refuse(_ device: PairedDevice, reason: String) async throws {
        try await store.revoke(device, reason: reason)
    }

    private func watch(until expiresAt: Date, minutes: Int?) async {
        while !Task.isCancelled {
            if now() >= expiresAt {
                stage = .expired(minutes: minutes)
                return
            }
            if let newcomer = try? await store.loadDevices().devices.first(where: {
                $0.status == "pending" && $0.pairingNumber != nil && !knownPending.contains($0.id)
            }) {
                stage = .asking(newcomer)
                return
            }
            try? await Task.sleep(for: pollInterval)
        }
    }
}
