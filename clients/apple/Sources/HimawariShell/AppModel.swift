import Foundation
import HimawariChat
import HimawariCore
import HimawariDesign
import Observation
#if canImport(UIKit)
import UIKit
#endif

public enum AppPhase: Equatable {
    case unpaired(PairingProblem?)
    case submitting
    case waitingForConfirmation(number: String)
    case active
}

@MainActor
@Observable
public final class AppModel {
    public private(set) var phase: AppPhase = .unpaired(nil)
    public private(set) var chat: ChatStore?
    public private(set) var configuration: DeviceConfiguration?

    @ObservationIgnored public let api: DeviceAPI
    @ObservationIgnored private let keys: SecureEnclaveKeyStore
    @ObservationIgnored private let keychain: KeychainValueStore
    @ObservationIgnored private let releaseChannel: ReleaseChannel
    @ObservationIgnored private var store: FileLocalStore?
    @ObservationIgnored private var waiting: Task<Void, Never>?
    @ObservationIgnored private let heartbeat = HeartbeatSetting()
    @ObservationIgnored private var lastScanned: String?

    private static let recordAccount = "pairing-record"

    public init(bundle: Bundle = .main) {
        let service = (bundle.bundleIdentifier ?? "himawari") + ".device"
        keys = SecureEnclaveKeyStore(service: service + ".keys")
        keychain = KeychainValueStore(service: service)
        let channel = bundle.object(forInfoDictionaryKey: "HimawariReleaseChannel") as? String
        releaseChannel = channel.flatMap(ReleaseChannel.init(rawValue:)) ?? .direct
        api = DeviceAPI(http: DeviceHTTPClient())
        restore()
    }

    private var record: PairingRecord? {
        keychain.read(Self.recordAccount).flatMap { try? JSONDecoder().decode(PairingRecord.self, from: $0) }
    }

    private func save(_ record: PairingRecord?) throws {
        try keychain.write(Self.recordAccount, try record.map { try JSONEncoder().encode($0) })
    }

    private func restore() {
        guard let record, keys.exists(.device), keys.exists(.confirm) else {
            phase = .unpaired(nil)
            return
        }
        use(record)
        switch record.status {
        case .pending:
            phase = .waitingForConfirmation(number: record.pairingNumber)
            waitForConfirmation()
        case .active:
            activate()
        case .revoked:
            forget(problem: .removed)
        }
    }

    private func use(_ record: PairingRecord) {
        api.http.use(DeviceCredentials(origin: record.origin, deviceId: record.deviceId, access: record.access, deviceKey: keys.signer(.device)))
    }

    public func pair(scanned text: String) {
        guard phase != .submitting else { return }
        lastScanned = text
        phase = .submitting
        Task {
            do {
                let invitation = try PairingInvitation.parse(text)
                try keys.create(.device)
                try keys.create(.confirm)
                let deviceKey = keys.signer(.device)
                let confirmKey = keys.signer(.confirm)
                let device = try await api.pair(
                    invitation: invitation,
                    kind: .iphone,
                    name: Self.deviceName,
                    releaseChannel: releaseChannel,
                    deviceKey: deviceKey,
                    confirmKey: confirmKey
                )
                let number = PairingNumber.display(
                    devicePublicKey: try deviceKey.publicKeySPKI(),
                    confirmPublicKey: try confirmKey.publicKeySPKI()
                )
                let record = PairingRecord(origin: invitation.origin, deviceId: device.id, access: invitation.access, status: device.status, pairingNumber: number)
                try save(record)
                use(record)
                if device.status == .active {
                    Haptics.shared.report(.pairingSucceeded)
                    activate()
                } else {
                    phase = .waitingForConfirmation(number: number)
                    waitForConfirmation()
                }
            } catch {
                try? keys.delete(.device)
                try? keys.delete(.confirm)
                phase = .unpaired(PairingProblem.from(error))
            }
        }
    }

    public func cancelPairing() {
        lastScanned = nil
        forget(problem: nil)
    }

    public func retryPairing() {
        guard let lastScanned else {
            phase = .unpaired(nil)
            return
        }
        pair(scanned: lastScanned)
    }

    public func dismissProblem() {
        lastScanned = nil
        phase = .unpaired(nil)
    }

    public var deviceDisplayName: String {
        Self.deviceName
    }

    private func waitForConfirmation() {
        waiting?.cancel()
        waiting = Task { [weak self] in
            var delay: UInt64 = 2
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    configuration = try await api.configuration()
                    try? save(record.map { var updated = $0; updated.status = .active; return updated })
                    Haptics.shared.report(.pairingSucceeded)
                    activate()
                    return
                } catch let error as DeviceAPIError where error.isRevoked {
                    forget(problem: .removed)
                    return
                } catch {}
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 10)
            }
        }
    }

    private func activate() {
        waiting?.cancel()
        do {
            let store = try FileLocalStore.applicationSupport(named: "himawari-device")
            self.store = store
            let heartbeat = heartbeat
            let chat = ChatStore(
                api: api,
                store: store,
                heartbeatSeconds: { heartbeat.seconds },
                onSessionInvalid: { [weak self] in self?.checkRevoked() }
            )
            self.chat = chat
            phase = .active
            chat.start()
            Task { await refreshConfiguration() }
        } catch {
            phase = .unpaired(.keysUnavailable)
        }
    }

    public func refreshConfiguration() async {
        do {
            let configuration = try await api.configuration()
            self.configuration = configuration
            heartbeat.seconds = TimeInterval(configuration.heartbeatSeconds)
        } catch let error as DeviceAPIError where error.isRevoked {
            forget(problem: .removed)
        } catch {}
    }

    private func checkRevoked() {
        Task { await refreshConfiguration() }
    }

    public func becameActive() {
        chat?.reconnect()
    }

    private func forget(problem: PairingProblem?) {
        waiting?.cancel()
        chat?.stop()
        chat = nil
        configuration = nil
        try? store?.removeAll()
        if store == nil, let fresh = try? FileLocalStore.applicationSupport(named: "himawari-device") {
            try? fresh.removeAll()
        }
        store = nil
        try? keys.delete(.device)
        try? keys.delete(.confirm)
        try? save(nil)
        api.http.use(nil)
        phase = .unpaired(problem)
    }

    static var deviceName: String {
        #if canImport(UIKit)
        UIDevice.current.name
        #else
        Host.current().localizedName ?? "Mac"
        #endif
    }
}

final class HeartbeatSetting: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = .infinity

    var seconds: TimeInterval {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}
