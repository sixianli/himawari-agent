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
    case confirmingServer(host: String)
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
    public var confirmKey: DeviceKeySigner { keys.signer(.confirm) }
    @ObservationIgnored private let keys: SecureEnclaveKeyStore
    @ObservationIgnored private let keychain: KeychainValueStore
    @ObservationIgnored private let releaseChannel: ReleaseChannel
    @ObservationIgnored private var store: FileLocalStore?
    @ObservationIgnored private var waiting: Task<Void, Never>?
    @ObservationIgnored private let heartbeat = HeartbeatSetting()
    @ObservationIgnored private var lastScanned: String?
    @ObservationIgnored private var keysMadeFor: String?
    @ObservationIgnored private var configurationRetry: Task<Void, Never>?

    private static let recordAccount = "pairing-record"

    public convenience init(bundle: Bundle = .main) {
        self.init(bundle: bundle, restoring: true)
    }

    init(bundle: Bundle = .main, restoring: Bool) {
        let service = (bundle.bundleIdentifier ?? "himawari") + ".device"
        keys = SecureEnclaveKeyStore(service: service + ".keys")
        keychain = KeychainValueStore(service: service)
        let channel = bundle.object(forInfoDictionaryKey: "HimawariReleaseChannel") as? String
        releaseChannel = channel.flatMap(ReleaseChannel.init(rawValue:)) ?? .direct
        api = DeviceAPI(http: DeviceHTTPClient())
        if restoring { restore() }
    }

    private var record: PairingRecord? {
        keychain.read(Self.recordAccount).flatMap { try? JSONDecoder().decode(PairingRecord.self, from: $0) }
    }

    private func save(_ record: PairingRecord?) throws {
        try keychain.write(Self.recordAccount, try record.map { try JSONEncoder().encode($0) })
    }

    private func restore() {
        guard let record, keys.exists(.device), keys.exists(.confirm) else {
            forget(problem: nil)
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
        do {
            let invitation = try PairingInvitation.parse(text)
            lastScanned = text
            phase = .confirmingServer(host: Self.host(invitation.origin))
        } catch {
            lastScanned = nil
            phase = .unpaired(PairingProblem.from(error))
        }
    }

    public func connectToScannedServer() {
        guard case .confirmingServer = phase, let lastScanned else { return }
        submit(lastScanned)
    }

    public func declineScannedServer() {
        lastScanned = nil
        keysMadeFor = nil
        phase = .unpaired(nil)
    }

    @ObservationIgnored var demoHost: String?

    public var serverHost: String? {
        if case let .confirmingServer(host) = phase { return host }
        return record.map { Self.host($0.origin) } ?? demoHost
    }

    #if DEBUG
    static func demo(_ phase: AppPhase, host: String? = nil) -> AppModel {
        let model = AppModel(restoring: false)
        model.phase = phase
        model.demoHost = host
        return model
    }
    #endif

    static func host(_ origin: URL) -> String {
        let host = origin.host ?? origin.absoluteString
        if let port = origin.port { return "\(host):\(port)" }
        return host
    }

    private func submit(_ text: String) {
        guard phase != .submitting else { return }
        phase = .submitting
        Task {
            do {
                let invitation = try PairingInvitation.parse(text)
                if keysMadeFor != text || !keys.exists(.device) || !keys.exists(.confirm) {
                    keysMadeFor = nil
                    try keys.create(.device)
                    try keys.create(.confirm)
                    keysMadeFor = text
                }
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
                let devicePublicKey = try deviceKey.publicKeySPKI()
                let confirmPublicKey = try confirmKey.publicKeySPKI()
                if let reported = device.pairingNumber,
                   reported != PairingNumber.digits(devicePublicKey: devicePublicKey, confirmPublicKey: confirmPublicKey) {
                    throw DeviceAPIError.invalidResponse
                }
                let number = PairingNumber.display(devicePublicKey: devicePublicKey, confirmPublicKey: confirmPublicKey)
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
                if !Self.mayHavePaired(error) {
                    keysMadeFor = nil
                    try? keys.delete(.device)
                    try? keys.delete(.confirm)
                }
                phase = .unpaired(PairingProblem.from(error))
            }
        }
    }

    static func mayHavePaired(_ error: Error) -> Bool {
        if error is PairingInvitation.ParseError || error is DeviceKeyError { return false }
        if case let .server(status, _, _)? = error as? DeviceAPIError { return status >= 500 || status == 408 || status == 429 }
        return true
    }

    public func cancelPairing() {
        lastScanned = nil
        keysMadeFor = nil
        forget(problem: nil)
    }

    public func retryPairing() {
        guard let lastScanned else {
            phase = .unpaired(nil)
            return
        }
        submit(lastScanned)
    }

    public func dismissProblem() {
        lastScanned = nil
        keysMadeFor = nil
        phase = .unpaired(nil)
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
        configurationRetry?.cancel()
        configurationRetry = nil
        do {
            let configuration = try await api.configuration()
            self.configuration = configuration
            heartbeat.seconds = TimeInterval(configuration.heartbeatSeconds)
        } catch let error as DeviceAPIError where error.isRevoked {
            forget(problem: .removed)
        } catch {
            retryConfiguration(failures: 1)
        }
    }

    private func retryConfiguration(failures: Int) {
        configurationRetry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(DeviceEventStream.backoff(failures: failures)))
            guard !Task.isCancelled, let self, phase == .active else { return }
            do {
                let configuration = try await api.configuration()
                self.configuration = configuration
                heartbeat.seconds = TimeInterval(configuration.heartbeatSeconds)
                configurationRetry = nil
            } catch let error as DeviceAPIError where error.isRevoked {
                forget(problem: .removed)
            } catch {
                retryConfiguration(failures: failures + 1)
            }
        }
    }

    private func checkRevoked() {
        Task { await refreshConfiguration() }
    }

    public func becameActive() {
        guard phase == .active else { return }
        chat?.reconnect()
        Task { await refreshConfiguration() }
    }

    public func removedThisDevice() {
        forget(problem: nil)
    }

    private func forget(problem: PairingProblem?) {
        waiting?.cancel()
        configurationRetry?.cancel()
        configurationRetry = nil
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
        PairingRequestLimits.deviceName(UIDevice.current.name)
        #else
        PairingRequestLimits.deviceName(Host.current().localizedName ?? "Mac")
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
