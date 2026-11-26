import Foundation
import HimawariChat
import HimawariCore
import HimawariActions
import HimawariDesign
import HimawariManage
import HimawariSenses
import HimawariShare
import Observation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(UserNotifications)
import UserNotifications
#endif
#if canImport(os)
import os
#endif

public enum AppPhase: Equatable {
    case signedOut(SignInProblem?)
    case signingIn
    case active
}

@MainActor
@Observable
public final class AppModel {
    #if canImport(UIKit)
    static let imageFitter: ImageFitting? = UIKitImageFitter()
    #else
    static let imageFitter: ImageFitting? = nil
    #endif

    public private(set) var phase: AppPhase = .signedOut(nil)
    public private(set) var serverOrigin: URL?
    public private(set) var signInInfo: SignInInfo?
    public private(set) var setupProblem: SignInProblem?
    public private(set) var chat: ChatStore?
    public private(set) var actions: DeviceActionsModel?
    public private(set) var configuration: DeviceConfiguration?
    public private(set) var senses: SensesModel?

    @ObservationIgnored public let api: DeviceAPI
    public var confirmKey: DeviceKeySigner { keys.signer(.confirm) }
    @ObservationIgnored public let vault: SharedVault
    @ObservationIgnored private let keys: SecureEnclaveKeyStore
    @ObservationIgnored private let keychain: KeychainValueStore
    @ObservationIgnored private let releaseChannel: ReleaseChannel
    @ObservationIgnored private let kind: DeviceKind
    @ObservationIgnored private var store: FileLocalStore? {
        didSet { if store !== oldValue { onDeviceStoreChange?(store) } }
    }
    @ObservationIgnored private let passkeys: PasskeyCeremony?
    @ObservationIgnored private let bundledOrigin: URL?
    @ObservationIgnored private let settings: UserDefaults
    @ObservationIgnored private var triedQuietly = false
    @ObservationIgnored private let heartbeat = HeartbeatSetting()
    @ObservationIgnored private let pushSync: PushTokenSync
    @ObservationIgnored private var configurationRetry: Task<Void, Never>?
    private static let recordAccount = SharedVault.recordAccount

    public convenience init(bundle: Bundle = .main, kind: DeviceKind = .iphone, passkeys: PasskeyCeremony? = nil) {
        Self.logUnknownServerValues(subsystem: bundle.bundleIdentifier ?? "himawari")
        self.init(bundle: bundle, kind: kind, passkeys: passkeys, restoring: true)
    }

    private static func logUnknownServerValues(subsystem: String) {
        #if canImport(os)
        let logger = Logger(subsystem: subsystem, category: "server-values")
        ServerValueDiagnostics.shared.observe { report in
            logger.notice("unknown \(report.type, privacy: .public) from server: \(report.raw, privacy: .public); shown as its fallback value")
        }
        let streams = Logger(subsystem: subsystem, category: "streams")
        StreamDiagnostics.shared.observe { problem in
            switch problem {
            case let .notOpened(path, connections):
                streams.error("stream \(path, privacy: .public) not opened: server allows \(connections, privacy: .public) connections, needs \(ExecutionStreamPolicy.streamsNeeded, privacy: .public)")
            case let .refused(path, status, code):
                streams.error("stream \(path, privacy: .public) refused: HTTP \(status, privacy: .public) \(code ?? "-", privacy: .public)")
            case let .dropped(path, reason, connectedSeconds):
                streams.notice("stream \(path, privacy: .public) dropped: \(reason.rawValue, privacy: .public) after \(connectedSeconds, format: .fixed(precision: 1), privacy: .public)s connected")
            case let .recovered(path, offlineSeconds):
                streams.notice("stream \(path, privacy: .public) back after \(offlineSeconds, format: .fixed(precision: 1), privacy: .public)s offline")
            }
        }
        #endif
    }

    init(bundle: Bundle = .main, kind: DeviceKind = .iphone, passkeys: PasskeyCeremony? = nil, restoring: Bool) {
        self.kind = kind
        #if canImport(AuthenticationServices)
        self.passkeys = passkeys ?? SystemPasskeys()
        #else
        self.passkeys = passkeys
        #endif
        bundledOrigin = ServerOrigin.bundled(bundle)
        settings = UserDefaults.standard
        serverOrigin = settings.string(forKey: Self.serverOverrideKey).flatMap(ServerOrigin.parse) ?? bundledOrigin
        let vault = SharedVault(bundle: bundle)
        self.vault = vault
        keys = vault.keys
        keychain = vault.keychain
        let channel = bundle.object(forInfoDictionaryKey: "HimawariReleaseChannel") as? String
        releaseChannel = channel.flatMap(ReleaseChannel.init(rawValue:)).flatMap { $0 == .unrecognized ? nil : $0 } ?? .direct
        let api = DeviceAPI(http: DeviceHTTPClient())
        self.api = api
        #if DEBUG
        let debugBuild = true
        #else
        let debugBuild = false
        #endif
        pushSync = PushTokenSync(
            transport: api,
            context: PushRegistrationContext(
                environment: PushRegistrationValues.environment(debugBuild: debugBuild),
                topic: bundle.bundleIdentifier ?? "",
                preferredLanguages: { Locale.preferredLanguages }
            )
        )
        #if os(iOS)
        PushBridge.sync = pushSync
        BackgroundWorkActivityTokens.watch(pushSync)
        NotificationRouter.shared.transport = api
        #endif
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
            phase = .signedOut(.keysUnreadable)
            return
        case .forget:
            forget(problem: nil)
            return
        case .use:
            break
        }
        guard let record else { return }
        switch record.status {
        case .active:
            use(record)
            activate()
        case .revoked:
            forget(problem: .removed)
        case .pending, .unrecognized:
            forget(problem: nil)
        }
    }

    private func use(_ record: PairingRecord) {
        api.http.use(DeviceCredentials(origin: record.origin, deviceId: record.deviceId, access: record.access, deviceKey: keys.signer(.device)))
    }

    static let serverOverrideKey = "himawari.serverOrigin"

    public var serverIsDefault: Bool { serverOrigin == bundledOrigin }

    public var signedOutProblem: SignInProblem? {
        if case let .signedOut(problem) = phase { return problem }
        return nil
    }

    public func loadSignInInfo() async {
        guard let origin = serverOrigin else { return }
        if let info = try? await api.signInInfo(origin: origin), origin == serverOrigin {
            signInInfo = info
        }
    }

    public func signInQuietly() async {
        guard !triedQuietly, phase == .signedOut(nil), serverOrigin != nil else { return }
        triedQuietly = true
        await signIn(quietly: true) { flow, origin, device in
            try await flow.signIn(origin: origin, device: device, info: self.signInInfo, immediatelyAvailableOnly: true)
        }
    }

    public func signInWithPasskey() async {
        triedQuietly = true
        await signIn(quietly: false) { flow, origin, device in
            try await flow.signIn(origin: origin, device: device, info: self.signInInfo, immediatelyAvailableOnly: false)
        }
    }

    public func setUp(code: String) async {
        setupProblem = nil
        if signInInfo == nil { await loadSignInInfo() }
        await signIn(quietly: false, setup: true) { flow, origin, device in
            try await flow.setUp(origin: origin, setupCode: code, device: device, info: self.signInInfo)
        }
    }

    public func clearSetupProblem() {
        setupProblem = nil
    }

    public func useServer(_ text: String) async -> Bool {
        guard let origin = ServerOrigin.parse(text), let info = try? await api.signInInfo(origin: origin) else { return false }
        serverOrigin = origin
        signInInfo = info
        if origin == bundledOrigin {
            settings.removeObject(forKey: Self.serverOverrideKey)
        } else {
            settings.set(origin.absoluteString, forKey: Self.serverOverrideKey)
        }
        return true
    }

    public func useDefaultServer() {
        settings.removeObject(forKey: Self.serverOverrideKey)
        serverOrigin = bundledOrigin
        signInInfo = nil
        Task { await loadSignInInfo() }
    }

    private func signIn(
        quietly: Bool,
        setup: Bool = false,
        _ attempt: @escaping @MainActor (SignInFlow, URL, SignInDevice) async throws -> PairedDeviceInfo
    ) async {
        guard phase != .signingIn, phase != .active, let origin = serverOrigin, let passkeys else { return }
        let before = phase
        phase = .signingIn
        do {
            try keys.create(.device)
            try keys.create(.confirm)
            let device = SignInDevice(
                kind: kind,
                name: Self.deviceName,
                releaseChannel: releaseChannel,
                devicePublicKey: try keys.signer(.device).publicKeySPKI(),
                confirmPublicKey: try keys.signer(.confirm).publicKeySPKI()
            )
            let signedIn = try await attempt(SignInFlow(api: api, ceremony: passkeys), origin, device)
            guard signedIn.status == .active else { throw DeviceAPIError.invalidResponse }
            let record = PairingRecord(origin: origin, deviceId: signedIn.id, access: nil, status: .active, pairingNumber: "")
            try save(record)
            use(record)
            Haptics.shared.report(.pairingSucceeded)
            activate()
        } catch {
            try? keys.delete(.device)
            try? keys.delete(.confirm)
            let problem = SignInProblem.from(error)
            if setup {
                setupProblem = problem
                phase = .signedOut(nil)
            } else if quietly || error as? PasskeyCeremonyError == .canceled {
                phase = before
            } else {
                phase = .signedOut(problem)
            }
        }
    }

    @ObservationIgnored var demoHost: String?

    @ObservationIgnored public var onDeviceNotification: (@MainActor (DeviceStreamEvent) -> Void)? {
        didSet { chat?.onNotification = onDeviceNotification }
    }

    @ObservationIgnored public var onDeviceStoreChange: (@MainActor (FileLocalStore?) -> Void)?

    public var deviceStore: FileLocalStore? { store }

    public func ownerPresence(reason: String) -> OwnerPresenceSigner {
        OwnerPresenceSigner(key: keys.signer(.confirm), reason: reason)
    }

    public var serverHost: String? {
        record.map { ServerOrigin.host($0.origin) } ?? demoHost ?? serverOrigin.map(ServerOrigin.host)
    }

    #if DEBUG
    public static func demo(_ phase: AppPhase, host: String? = nil, kind: DeviceKind = .iphone, setupProblem: SignInProblem? = nil) -> AppModel {
        let model = AppModel(kind: kind, restoring: false)
        model.phase = phase
        model.demoHost = host
        model.setupProblem = setupProblem
        if let host {
            model.serverOrigin = ServerOrigin.parse(host)
            model.signInInfo = SignInInfo(rpId: host, setupCode: SetupCodeRule(length: 8, groupSize: 4, alphabet: "ABCDEFGHJKMNPQRSTUVWXYZ23456789"))
        }
        model.configuration = demoConfiguration
        return model
    }

    private static let demoConfiguration = try? JSONDecoder().decode(DeviceConfiguration.self, from: Data("""
    {"heartbeatSeconds":25,"connectionMaxSeconds":3600,"signatureToleranceSeconds":300,"limits":[],"streamConnections":4,
     "attachments":{"textCharacters":200000,"imageCharacters":4000000,"perMessage":4,"messageCharacters":4000000}}
    """.utf8))

    public func useDemoDeviceStore(_ store: FileLocalStore?) {
        self.store = store
    }
    #endif

    public var unsentMessages: Int? {
        guard let local = try? store ?? FileLocalStore.applicationSupport(named: "himawari-device") else { return nil }
        return Outbox.unsentCount(in: local)
    }

    public func startOver() {
        guard emptyStore() else {
            phase = .signedOut(.storageUnavailable)
            return
        }
        forget(problem: nil)
    }

    private func emptyStore() -> Bool {
        chat?.stop()
        chat = nil
        senses?.suspend()
        senses = nil
        actions = nil
        do {
            try (store ?? FileLocalStore.applicationSupport(named: "himawari-device")).retire()
            return true
        } catch {
            return false
        }
    }

    public func retryReadingKeys() {
        restore()
    }

    private func activate() {
        guard let record else {
            phase = .signedOut(.keysUnreadable)
            return
        }
        do {
            let store = try FileLocalStore.applicationSupport(named: "himawari-device")
            try store.claim(for: record.deviceId)
            self.store = store
            let heartbeat = heartbeat
            let executor = DeviceActionExecutor(
                transport: api,
                journal: DeviceActionJournal(store: store),
                handlers: AppleDeviceActions.handlers(),
                now: { [http = api.http] in http.correctedNow }
            )
            let actions = DeviceActionsModel(api: api, executor: executor, confirm: keys.signer(.confirm), store: store)
            self.actions = actions
            let chat = ChatStore(
                api: api,
                store: store,
                heartbeatSeconds: { heartbeat.seconds },
                onSessionInvalid: { [weak self] in self?.checkRevoked() },
                onDeviceActions: { [weak actions] in actions?.deviceActionsChanged() },
                images: Self.imageFitter
            )
            chat.onNotification = onDeviceNotification
            self.chat = chat
            let service = LiveSensesService(
                api: api,
                store: store,
                deviceId: record.deviceId,
                confirmation: EnclaveConfirmation(keys: keys),
                operations: Self.phoneOperations([SenseOperation.deleteRecords]),
                configuration: { [weak self] in self?.configuration },
                refreshConfiguration: { [weak self] in await self?.refreshConfiguration() }
            )
            let senses = SensesModel(service: service, store: store)
            self.senses = senses
            phase = .active
            chat.start()
            actions.deviceActionsChanged()
            Task {
                await refreshConfiguration()
                await senses.refresh()
            }
            deliverWaitingHandovers()
            registerForPush()
        } catch {
            phase = .signedOut(.storageUnavailable)
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

    @ObservationIgnored private var handoverDrain: Task<Void, Never>?

    private func deliverWaitingHandovers() {
        guard handoverDrain == nil, let store = try? vault.handoverStore() else { return }
        let queue = HandoverQueue(store: store)
        guard !queue.pending().isEmpty else { return }
        #if canImport(UIKit)
        let courier = HandoverCourier(api: api, images: UIKitImageFitter())
        #else
        let courier = HandoverCourier(api: api)
        #endif
        handoverDrain = Task { [weak self] in
            let results = await queue.drain(using: courier)
            guard let self else { return }
            handoverDrain = nil
            if results.values.contains(.deviceRemoved) { checkRevoked() }
        }
    }

    private func checkRevoked() {
        Task { await refreshConfiguration() }
    }

    public func becameActive() {
        if phase == .signedOut(.keysUnreadable) || phase == .signedOut(.storageUnavailable) {
            restore()
            return
        }
        guard phase == .active else { return }
        chat?.reconnect()
        actions?.deviceActionsChanged()
        deliverWaitingHandovers()
        removeSettledNotifications()
        registerForPush()
        Task {
            await refreshConfiguration()
            await senses?.refresh()
        }
    }

    private func registerForPush() {
        #if os(iOS)
        let sync = pushSync
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            UIApplication.shared.registerForRemoteNotifications()
            await sync.deviceReady()
        }
        #endif
    }

    private func removeSettledNotifications() {
        #if canImport(UserNotifications)
        let settler = NotificationSettler(center: SystemDeliveredNotifications(), source: api)
        Task { await settler.reconcile() }
        #endif
    }

    public func removedThisDevice() {
        forget(problem: nil)
    }

    private func forget(problem: SignInProblem?) {
        configurationRetry?.cancel()
        configurationRetry = nil
        _ = emptyStore()
        configuration = nil
        store = nil
        try? keys.delete(.device)
        try? keys.delete(.confirm)
        try? save(nil)
        api.http.use(nil)
        Task { [pushSync] in await pushSync.deviceGone() }
        phase = .signedOut(problem)
    }

    static var deviceName: String {
        #if canImport(UIKit)
        PairingRequestLimits.deviceName(UIDevice.current.name)
        #else
        PairingRequestLimits.deviceName(Host.current().localizedName ?? "", fallback: "Mac")
        #endif
    }
}

struct EnclaveConfirmation: ConfirmationSigner {
    let keys: SecureEnclaveKeyStore

    func confirmKey() -> DeviceKeySigner {
        keys.signer(.confirm)
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

extension AppModel {
    static func phoneOperations(_ types: [String]) -> Set<String> {
        Set(types.filter { type in
            guard let capability = ClientCapabilities.find(.v2, type) else { return false }
            return capability.tier != .notOnPhone
        })
    }
}
