import HimawariCore
import HimawariDesign
import Observation
import SwiftUI

public enum HerSection: String, CaseIterable, Hashable, Sendable {
    case approvals
    case personalization
    case notifications
    case passwords
    case noMoreAsking
    case about

    var entry: HerEntry? {
        switch self {
        case .approvals: nil
        case .personalization: .personalization
        case .notifications: .notifications
        case .passwords: .passwords
        case .noMoreAsking: .noMoreAsking
        case .about: .about
        }
    }

    public var group: String? { entry?.group.rawValue }

    public var title: String {
        entry?.title ?? L.text("approval.title")
    }

    public var icon: IconName {
        entry?.icon ?? .handStop
    }
}

@MainActor
@Observable
public final class HerWorkspace {
    let settings: SettingsStore
    let memory: MemoryStore
    let quietHours: QuietHoursStore
    let timers: TimersStore
    let personal: PersonalStore
    public private(set) var vaultCount: HerVaultCount = .unknown
    @ObservationIgnored let api: DeviceAPI
    @ObservationIgnored let confirmKey: DeviceKeySigner
    @ObservationIgnored let server: String?

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner) {
        self.api = api
        self.confirmKey = confirmKey
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        let identity = api.http.currentCredentials.map {
            DeviceIdentity(deviceId: $0.deviceId, origin: $0.origin, access: $0.access)
        }
        server = identity?.origin.absoluteString
        settings = SettingsStore(gateway: gateway, identity: identity)
        memory = MemoryStore(gateway: gateway)
        quietHours = QuietHoursStore(gateway: gateway)
        timers = TimersStore(gateway: gateway)
        personal = PersonalStore(gateway: gateway, loadModels: { try? await api.configuration().chatModels })
    }

    public func load() async {
        async let settingsLoaded: Void = settings.load()
        async let memoryLoaded: Void = memory.load()
        async let quietLoaded: Void = quietHours.load()
        async let timersLoaded: Void = timers.load()
        async let personalLoaded: Void = personal.load()
        vaultCount = await countVault()
        _ = await (settingsLoaded, memoryLoaded, quietLoaded, timersLoaded, personalLoaded)
    }

    public func isAvailable(_ section: HerSection, actions: DeviceActionsModel?) -> Bool {
        switch section {
        case .personalization, .noMoreAsking, .about: true
        case .approvals: actions != nil
        case .notifications: timers.phase != .unsupported || quietHours.hours != nil
        case .passwords: vaultCount != .unsupported && Self.vaultBuilt
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
    @State private var path: [HerPage.Page] = []

    public init(
        section: HerSection,
        workspace: HerWorkspace,
        actions: DeviceActionsModel?,
        talk: @escaping (String) -> Void,
        openChat: @escaping () -> Void,
        removedThisDevice: @escaping () -> Void
    ) {
        self.section = section
        self.workspace = workspace
        self.actions = actions
        self.talk = talk
        self.openChat = openChat
        self.removedThisDevice = removedThisDevice
    }

    public var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: HerPage.Page.self) { page in
                    destination(page)
                }
        }
        .environment(\.herInSidebar, true)
    }

    @ViewBuilder
    private var root: some View {
        switch section {
        case .approvals:
            if let actions {
                ApprovalsView(model: actions, openThread: { _ in openChat() }, close: openChat)
            }
        case .personalization:
            PersonalizationPage(personal: workspace.personal)
        case .notifications:
            NotificationsHubPage(timers: workspace.timers, quietHours: workspace.quietHours)
        case .passwords:
            #if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)
            VaultRootView(api: workspace.api, confirmKey: workspace.confirmKey, close: openChat)
            #endif
        case .noMoreAsking:
            HerAllowancesPage(memory: workspace.memory, back: openChat)
        case .about:
            AboutPage(server: workspace.server, openTiming: { path.append(.talkTiming) }, back: openChat)
        }
    }

    @ViewBuilder
    private func destination(_ page: HerPage.Page) -> some View {
        switch page {
        case .name:
            NamePage(store: workspace.personal) { path.removeLast() }
        case .rules:
            RulesPage(store: workspace.memory, quietHours: workspace.quietHours.hours, talk: talk)
        case .model:
            ModelPage(store: workspace.personal) { path.removeLast() }
        case .memory:
            MemoryRootView(store: workspace.memory, talk: talk)
        case .timers:
            TimersPage(store: workspace.timers, open: { path.append(.timer($0)) }) { path.removeLast() }
        case .notifications:
            NotificationsPage(store: workspace.quietHours) { path.removeLast() }
        case .timer(let id):
            TimerDetailPage(store: workspace.timers, timerId: id) { path.removeLast() }
        case .device(let id):
            DevicePage(store: workspace.settings, deviceId: id, actions: actions, removedThisDevice: removedThisDevice) { path.removeLast() }
        case .talkTiming:
            TalkTimingPage(load: { [api = workspace.api] in try await api.voiceTimings() })
        default:
            EmptyView()
        }
    }
}
