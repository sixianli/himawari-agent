import Foundation
import HimawariChat
import HimawariCore
import HimawariDesign
import Observation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(os)
import os
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
    @ObservationIgnored private let keys: SecureEnclaveKeyStore
    @ObservationIgnored private let keychain: KeychainValueStore
    @ObservationIgnored private let releaseChannel: ReleaseChannel
    @ObservationIgnored private let kind: DeviceKind
    @ObservationIgnored private var store: FileLocalStore?
    @ObservationIgnored private var waiting: Task<Void, Never>?
    @ObservationIgnored private let heartbeat = HeartbeatSetting()
    @ObservationIgnored private var lastScanned: String?
    @ObservationIgnored private var keysMadeFor: String?
    @ObservationIgnored private var configurationRetry: Task<Void, Never>?
    #if os(iOS)
    @ObservationIgnored private let watchRelay = PhoneWatchRelay()
    #endif
    public private(set) var watchOffer: String?

    private static let recordAccount = "pairing-record"

    public convenience init(bundle: Bundle = .main, kind: DeviceKind = .iphone) {
        Self.logUnknownServerValues(subsystem: bundle.bundleIdentifier ?? "himawari")
        self.init(bundle: bundle, kind: kind, restoring: true)
    }

    private static func logUnknownServerValues(subsystem: String) {
        #if canImport(os)
        let logger = Logger(subsystem: subsystem, category: "server-values")
        ServerValueDiagnostics.shared.observe { report in
            logger.notice("unknown \(report.type, privacy: .public) from server: \(report.raw, privacy: .public); shown as its fallback value")
        }
        #endif
    }

    init(bundle: Bundle = .main, kind: DeviceKind = .iphone, restoring: Bool) {
        self.kind = kind
        let service = (bundle.bundleIdentifier ?? "himawari") + ".device"
        keys = SecureEnclaveKeyStore(service: service + ".keys")
        keychain = KeychainValueStore(service: service)
        let channel = bundle.object(forInfoDictionaryKey: "HimawariReleaseChannel") as? String
        releaseChannel = channel.flatMap(ReleaseChannel.init(rawValue:)).flatMap { $0 == .unrecognized ? nil : $0 } ?? .direct
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
        let presence = [keychain.presence(Self.recordAccount), keys.presence(.device), keys.presence(.confirm)]
        let record = record
        switch RestoreDecision.decide(presence: presence, recordDecodes: record != nil) {
        case .unreadable:
            phase = .unpaired(.keysUnreadable)
            return
        case .forget:
            forget(problem: nil)
            return
        case .use:
            break
        }
        guard let record else { return }
        use(record)
        switch record.status {
        case .pending, .unrecognized:
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

    public func handlePairingLink(_ text: String) {
        if phase == .active {
            #if os(iOS)
            if let invitation = try? PairingInvitation.parse(text), invitation.origin == record?.origin, watchRelay.canOffer {
                watchOffer = text
            }
            #endif
            return
        }
        pair(scanned: text)
    }

    public var watchOfferHost: String? {
        guard let watchOffer, let invitation = try? PairingInvitation.parse(watchOffer) else { return nil }
        return Self.host(invitation.origin)
    }

    public func sendOfferToWatch() {
        #if os(iOS)
        if let watchOffer { watchRelay.send(watchOffer) }
        #endif
        watchOffer = nil
    }

    public func declineWatchOffer() {
        watchOffer = nil
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
    public static func demo(_ phase: AppPhase, host: String? = nil, kind: DeviceKind = .iphone) -> AppModel {
        let model = AppModel(kind: kind, restoring: false)
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
                    kind: kind,
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
                if !PairingAttempt.mayHavePaired(error) {
                    keysMadeFor = nil
                    try? keys.delete(.device)
                    try? keys.delete(.confirm)
                }
                phase = .unpaired(PairingProblem.from(error))
            }
        }
    }

    public func cancelPairing() {
        lastScanned = nil
        keysMadeFor = nil
        forget(problem: nil)
    }

    public var unsentMessages: Int? {
        guard let local = try? store ?? FileLocalStore.applicationSupport(named: "himawari-device") else { return nil }
        return Outbox.unsentCount(in: local)
    }

    public func startOver() {
        guard emptyStore() else {
            phase = .unpaired(.storageUnavailable)
            return
        }
        cancelPairing()
    }

    private func emptyStore() -> Bool {
        chat?.stop()
        chat = nil
        do {
            try (store ?? FileLocalStore.applicationSupport(named: "himawari-device")).retire()
            return true
        } catch {
            return false
        }
    }

    public func retryReadingKeys() {
        if phase == .unpaired(.stateUnknown) {
            recheckUnknownState()
        } else {
            restore()
        }
    }

    private func recheckUnknownState() {
        waiting?.cancel()
        waiting = Task { [weak self] in
            guard let self else { return }
            var failure: Error?
            do {
                configuration = try await api.configuration()
            } catch {
                failure = error
            }
            guard !Task.isCancelled, phase == .unpaired(.stateUnknown) else { return }
            switch UnknownStateRecheck.outcome(of: failure) {
            case .connected:
                try? save(record.map { var updated = $0; updated.status = .active; return updated })
                Haptics.shared.report(.pairingSucceeded)
                activate()
            case .removed:
                forget(problem: .removed)
            case .waiting:
                if let record {
                    phase = .waitingForConfirmation(number: record.pairingNumber)
                    waitForConfirmation()
                }
            case .stillUnknown:
                break
            }
        }
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
                } catch {
                    if let status = record?.status, ConfirmationWait.givesUp(waitingAs: status, after: error) {
                        phase = .unpaired(.stateUnknown)
                        return
                    }
                }
                try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                delay = min(delay * 2, 10)
            }
        }
    }

    private func activate() {
        waiting?.cancel()
        guard let record else {
            phase = .unpaired(.keysUnreadable)
            return
        }
        do {
            let store = try FileLocalStore.applicationSupport(named: "himawari-device")
            try store.claim(for: record.deviceId)
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
            phase = .unpaired(.storageUnavailable)
        }
    }

    public func refreshConfiguration() async {
        configurationRetry?.cancel()
        configurationRetry = nil
        do {
            let configuration = try await api.configuration()
            self.configuration = configuration
            heartbeat.seconds = TimeInterval(configuration.heartbeatSeconds)
            chat?.limitStreams(to: configuration.streamConnections)
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
                chat?.limitStreams(to: configuration.streamConnections)
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
        if phase == .unpaired(.stateUnknown) {
            recheckUnknownState()
            return
        }
        if phase == .unpaired(.keysUnreadable) || phase == .unpaired(.storageUnavailable) {
            restore()
            return
        }
        guard phase == .active else { return }
        chat?.reconnect()
        Task { await refreshConfiguration() }
    }

    private func forget(problem: PairingProblem?) {
        waiting?.cancel()
        configurationRetry?.cancel()
        configurationRetry = nil
        let emptied = emptyStore()
        configuration = nil
        store = nil
        try? keys.delete(.device)
        try? keys.delete(.confirm)
        try? save(nil)
        api.http.use(nil)
        phase = .unpaired(ForgetOutcome.problem(wanted: problem, storeEmptied: emptied))
    }

    static var deviceName: String {
        #if canImport(UIKit)
        PairingRequestLimits.deviceName(UIDevice.current.name)
        #else
        PairingRequestLimits.deviceName(Host.current().localizedName ?? "", fallback: "Mac")
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
