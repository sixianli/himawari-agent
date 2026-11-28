import HimawariCore
import HimawariDesign
import Observation
import SwiftUI

public enum HerSection: String, CaseIterable, Hashable, Sendable {
    case memory
    case rules
    case approvals
    case timers
    case allowances
    case vault
    case notifications
    case privacy
    case about

    public var title: String {
        switch self {
        case .memory: M.herMemory
        case .rules: M.rules
        case .approvals: L.text("approval.title")
        case .timers: M.timersTitle
        case .allowances: M.allowancesTitle
        case .vault: M.vaultTitle
        case .notifications: M.quietTitle
        case .privacy: M.privacy
        case .about: M.aboutTitle
        }
    }

    public var icon: IconName {
        switch self {
        case .memory: .affiliate
        case .rules: .clipboardList
        case .approvals: .handStop
        case .timers: .alarm
        case .allowances: .shieldCheck
        case .vault: .key
        case .notifications: .bell
        case .privacy: .eye
        case .about: .infoCircle
        }
    }
}

@MainActor
@Observable
public final class HerWorkspace {
    let settings: SettingsStore
    let memory: MemoryStore
    let quietHours: QuietHoursStore
    let timers: TimersStore
    public private(set) var vaultCount: HerVaultCount = .unknown
    @ObservationIgnored let api: DeviceAPI
    @ObservationIgnored let confirmKey: DeviceKeySigner
    @ObservationIgnored let server: String?

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner) {
        self.api = api
        self.confirmKey = confirmKey
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        server = api.http.currentCredentials?.origin.absoluteString
        settings = SettingsStore(directory: SignedDeviceDirectory(http: api.http, confirmKey: confirmKey))
        memory = MemoryStore(gateway: gateway)
        quietHours = QuietHoursStore(gateway: gateway)
        timers = TimersStore(gateway: gateway)
    }

    public func load() async {
        async let settingsLoaded: Void = settings.load()
        async let memoryLoaded: Void = memory.load()
        async let quietLoaded: Void = quietHours.load()
        async let timersLoaded: Void = timers.load()
        vaultCount = await countVault()
        _ = await (settingsLoaded, memoryLoaded, quietLoaded, timersLoaded)
    }

    public func isAvailable(_ section: HerSection, actions: DeviceActionsModel?) -> Bool {
        switch section {
        case .memory, .rules, .allowances, .privacy, .about: true
        case .approvals: actions != nil
        case .timers: timers.phase != .unsupported
        case .vault: vaultCount != .unsupported && Self.vaultBuilt
        case .notifications: quietHours.hours != nil
        }
    }

    private static var vaultBuilt: Bool {
        #if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)
        true
        #else
        false
        #endif
    }

    private func countVault() async -> HerVaultCount {
        do {
            return .items(try await api.vaultSnapshot().items.count)
        } catch DeviceAPIError.server(let status, _, _, _) where status == 404 {
            return .unsupported
        } catch {
            return .unknown
        }
    }
}

extension EnvironmentValues {
    @Entry public var herInSidebar = false
}

public struct HerSectionView: View {
    private let section: HerSection
    private let workspace: HerWorkspace
    private let actions: DeviceActionsModel?
    private let talk: (String) -> Void
    private let openChat: () -> Void
    private let removedThisDevice: () -> Void
    private let unsentMessages: () -> Int?
    private let senses: AnyView?
    private let perceptionDeletion: ((@escaping () -> Void) -> AnyView)?
    private let sensesOn: () -> Int?
    @State private var path: [HerPage.Page] = []
    @State private var sensesOpen = false
    @State private var deletionOpen = false

    public init(
        section: HerSection,
        workspace: HerWorkspace,
        actions: DeviceActionsModel?,
        senses: AnyView? = nil,
        perceptionDeletion: ((@escaping () -> Void) -> AnyView)? = nil,
        sensesOn: @escaping () -> Int? = { nil },
        talk: @escaping (String) -> Void,
        openChat: @escaping () -> Void,
        removedThisDevice: @escaping () -> Void,
        unsentMessages: @escaping () -> Int? = { nil }
    ) {
        self.section = section
        self.workspace = workspace
        self.actions = actions
        self.senses = senses
        self.perceptionDeletion = perceptionDeletion
        self.sensesOn = sensesOn
        self.talk = talk
        self.openChat = openChat
        self.removedThisDevice = removedThisDevice
        self.unsentMessages = unsentMessages
    }

    public var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: HerPage.Page.self) { page in
                    destination(page)
                }
        }
        .environment(\.herInSidebar, true)
        .sheet(isPresented: $sensesOpen) {
            senses
        }
        .sheet(isPresented: $deletionOpen) {
            perceptionDeletion?({ deletionOpen = false })
        }
    }

    @ViewBuilder
    private var root: some View {
        switch section {
        case .memory:
            MemoryRootView(store: workspace.memory, talk: talk)
        case .rules:
            RulesPage(store: workspace.memory, quietHours: workspace.quietHours.hours, talk: talk)
        case .approvals:
            if let actions {
                ApprovalsView(model: actions, openThread: { _ in openChat() }, close: openChat)
            }
        case .timers:
            TimersPage(store: workspace.timers, open: { path.append(.timer($0)) }, back: openChat)
        case .allowances:
            HerAllowancesPage(memory: workspace.memory, back: openChat)
        case .vault:
            #if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)
            VaultRootView(api: workspace.api, confirmKey: workspace.confirmKey, close: openChat)
            #endif
        case .notifications:
            NotificationsPage(store: workspace.quietHours, back: openChat)
        case .privacy:
            PrivacyPage(
                memory: workspace.memory,
                listening: nil,
                openListening: {},
                openVoiceprint: {},
                openSenses: senses == nil ? nil : { sensesOpen = true },
                openDeletion: perceptionDeletion == nil ? nil : { deletionOpen = true },
                sensesSummary: sensesOn().map(M.sensesOn),
                back: openChat
            )
        case .about:
            AboutPage(server: workspace.server, openTiming: { path.append(.talkTiming) }, back: openChat)
        }
    }

    @ViewBuilder
    private func destination(_ page: HerPage.Page) -> some View {
        switch page {
        case .timer(let id):
            TimerDetailPage(store: workspace.timers, timerId: id) { path.removeLast() }
        case .device(let id):
            DevicePage(store: workspace.settings, deviceId: id, actions: actions, unsentMessages: unsentMessages, removedThisDevice: removedThisDevice) { path.removeLast() }
        case .talkTiming:
            TalkTimingPage(load: { [api = workspace.api] in try await api.voiceTimings() })
        default:
            EmptyView()
        }
    }
}
