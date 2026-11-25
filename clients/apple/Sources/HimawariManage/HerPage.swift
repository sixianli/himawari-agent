import HimawariCore
import HimawariDesign
import SwiftUI

@MainActor
public protocol HerListening: AnyObject, Sendable {
    var hasVoiceprint: Bool { get }
    func deleteVoiceprint()
}

public enum HerVaultCount: Equatable, Sendable {
    case unsupported
    case unknown
    case items(Int)
}

public struct HerPage: View {
    enum Page: Hashable {
        case memory
        case notifications
        case privacy
        case devices
        case device(String)
        case approvals
        case allowances
        case about
    }

    @State private var settings: SettingsStore
    @State private var memory: MemoryStore
    @State private var quietHours: QuietHoursStore
    @State private var path: [Page] = []
    @State private var sensesOpen = false
    @State private var vaultCount: HerVaultCount = .unknown
    @State private var vaultOpen = false
    private let listening: (any HerListening)?
    private let actions: DeviceActionsModel?
    private let openListening: () -> Void
    private let senses: AnyView?
    private let sensesOn: () -> Int?
    private let talk: (String) -> Void
    private let close: () -> Void
    private let removedThisDevice: () -> Void
    private let countVault: () async -> HerVaultCount
    private let vault: ((@escaping () -> Void) -> AnyView)?
    private let server: String?

    public init(
        api: DeviceAPI,
        confirmKey: DeviceKeySigner,
        listening: (any HerListening)? = nil,
        actions: DeviceActionsModel? = nil,
        openListening: @escaping () -> Void = {},
        senses: AnyView? = nil,
        sensesOn: @escaping () -> Int? = { nil },
        talk: @escaping (String) -> Void,
        close: @escaping () -> Void,
        removedThisDevice: @escaping () -> Void
    ) {
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        let identity = api.http.currentCredentials.map {
            DeviceIdentity(deviceId: $0.deviceId, origin: $0.origin, access: $0.access)
        }
        server = identity?.origin.absoluteString
        _settings = State(initialValue: SettingsStore(gateway: gateway, identity: identity))
        _memory = State(initialValue: MemoryStore(gateway: gateway))
        _quietHours = State(initialValue: QuietHoursStore(gateway: gateway))
        self.listening = listening
        self.actions = actions
        self.openListening = openListening
        self.senses = senses
        self.sensesOn = sensesOn
        self.talk = talk
        self.close = close
        self.removedThisDevice = removedThisDevice
        countVault = {
            do {
                return .items(try await api.vaultSnapshot().items.count)
            } catch DeviceAPIError.server(let status, _, _, _) where status == 404 {
                return .unsupported
            } catch {
                return .unknown
            }
        }
        #if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)
        vault = { close in AnyView(VaultRootView(api: api, confirmKey: confirmKey, close: close)) }
        #else
        vault = nil
        #endif
    }

    init(settings: SettingsStore, memory: MemoryStore, quietHours: QuietHoursStore, listening: (any HerListening)? = nil, actions: DeviceActionsModel? = nil, senses: AnyView? = nil, vaultItems: HerVaultCount = .items(3), path: [Page] = []) {
        _settings = State(initialValue: settings)
        _memory = State(initialValue: memory)
        _quietHours = State(initialValue: quietHours)
        _path = State(initialValue: path)
        self.listening = listening
        self.actions = actions
        openListening = {}
        self.senses = senses
        sensesOn = { 4 }
        talk = { _ in }
        close = {}
        removedThisDevice = {}
        let shown = vaultItems
        countVault = { shown }
        server = "https://himawari.example"
        vault = nil
    }

    public var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: DesignTokens.Her.pageGap) {
                    HerHero()
                    if let actions, actions.waitingCount > 0 {
                        SettingsGroup(label: nil) {
                            Button { path.append(.approvals) } label: {
                                HerRow(icon: .handStop, title: M.approvalsWaiting(actions.waitingCount), last: true)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    SettingsGroup(label: nil) {
                        Button { path.append(.memory) } label: {
                            HerRow(icon: .affiliate, title: M.herMemory, subtitle: memory.summary(categoryLabel: M.category).map(M.memorySummary), last: true)
                        }
                        .buttonStyle(.plain)
                    }
                    SettingsGroup(label: nil) {
                        Button { path.append(.allowances) } label: {
                            HerRow(icon: .shieldCheck, title: M.allowancesTitle, subtitle: M.allowancesSummary(memory.allowances.count), last: vaultCount == .unsupported)
                        }
                        .buttonStyle(.plain)
                        if vaultCount != .unsupported {
                            Button { vaultOpen = true } label: {
                                HerRow(icon: .key, title: M.vaultTitle, subtitle: M.vaultSummary(vaultCount), last: true)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    SettingsGroup(label: nil) {
                        if let hours = quietHours.hours {
                            Button { path.append(.notifications) } label: {
                                HerRow(icon: .bell, title: M.notificationsTitle, subtitle: M.quietSummary(hours))
                            }
                            .buttonStyle(.plain)
                        }
                        Button { path.append(.privacy) } label: {
                            HerRow(icon: .eye, title: M.privacy)
                        }
                        .buttonStyle(.plain)
                        Button { path.append(.devices) } label: {
                            HerRow(icon: .deviceMobilePlain, title: M.devicesTitle, subtitle: devicesSummary, last: true)
                        }
                        .buttonStyle(.plain)
                    }
                    SettingsGroup(label: nil) {
                        Button { path.append(.about) } label: {
                            HerRow(icon: .infoCircle, title: M.aboutTitle, subtitle: AboutPage.versionLine, last: true)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, DesignTokens.Her.pagePaddingTop)
                .padding(.horizontal, DesignTokens.Size.pagePaddingX)
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
            }
            .scrollIndicators(.hidden)
            .refreshable { await load() }
            .overlay(alignment: .topLeading) {
                GlassCircleButton(Text(M.collapse), action: close) {
                    Icon(.chevronDown, size: DesignTokens.IconSize.glassButton)
                }
                .padding(.leading, DesignTokens.Size.pagePaddingX)
                .padding(.top, DesignTokens.Size.sheetPaddingTop)
            }
            .himawariScreenBackground()
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            .navigationDestination(for: Page.self) { page in
                switch page {
                case .memory:
                    MemoryRootView(store: memory, talk: talk, back: { path.removeLast() })
                        #if os(iOS)
                        .toolbar(.hidden, for: .navigationBar)
                        #endif
                case .notifications:
                    NotificationsPage(store: quietHours) { path.removeLast() }
                case .privacy:
                    PrivacyPage(
                        memory: memory,
                        listening: listening,
                        openListening: openListening,
                        openSenses: senses == nil ? nil : { sensesOpen = true },
                        sensesSummary: sensesOn().map(M.sensesOn)
                    ) { path.removeLast() }
                case .devices:
                    HerDevicesPage(store: settings, open: { path.append(.device($0.id)) }, removedThisDevice: removedThisDevice) { path.removeLast() }
                case .device(let id):
                    DevicePage(store: settings, deviceId: id, actions: actions, removedThisDevice: removedThisDevice) { path.removeLast() }
                case .allowances:
                    HerAllowancesPage(memory: memory) { path.removeLast() }
                case .about:
                    AboutPage(server: server) { path.removeLast() }
                case .approvals:
                    if let actions {
                        ApprovalsView(model: actions, openThread: { _ in close() }) { path.removeLast() }
                            #if os(iOS)
                            .toolbar(.hidden, for: .navigationBar)
                            #endif
                    }
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $sensesOpen) {
            senses
        }
        .sheet(isPresented: $vaultOpen, onDismiss: { Task { vaultCount = await countVault() } }) {
            vault?({ vaultOpen = false })
        }
    }

    private var devicesSummary: String? {
        guard settings.phase == .loaded, settings.devices.contains(where: settings.isThisDevice) else { return nil }
        return M.thisIPhone
    }

    private func load() async {
        async let settingsLoaded: Void = settings.load()
        async let memoryLoaded: Void = memory.load()
        async let quietLoaded: Void = quietHours.load()
        vaultCount = await countVault()
        _ = await (settingsLoaded, memoryLoaded, quietLoaded)
    }
}

struct HerHero: View {
    var body: some View {
        VStack(spacing: DesignTokens.Her.heroGap) {
            ZStack {
                Circle()
                    .fill(Color.hmSpeak)
                    .frame(width: DesignTokens.Her.heroAvatar, height: DesignTokens.Her.heroAvatar)
                SunflowerMark()
                    .frame(width: DesignTokens.Her.heroMark, height: DesignTokens.Her.heroMark)
            }
            Wordmark(size: DesignTokens.Her.heroWordmarkSize)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, DesignTokens.Her.heroPaddingTop)
        .padding(.bottom, DesignTokens.Her.heroPaddingBottom)
    }
}

struct HerRow: View {
    let icon: IconName
    let title: String
    var subtitle: String? = nil
    var value: String? = nil
    var chevron = true
    var last = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                Icon(icon, size: DesignTokens.Her.rowIcon)
                    .foregroundStyle(Color.hmGlyph)
                    .frame(width: DesignTokens.Her.rowTile, height: DesignTokens.Her.rowTile)
                    .background(Color.hmTile, in: RoundedRectangle(cornerRadius: DesignTokens.Her.rowTileRadius, style: .continuous))
                VStack(alignment: .leading, spacing: DesignTokens.Her.rowSubtitleGap) {
                    Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    if let subtitle {
                        Text(subtitle).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let value {
                    Text(value).hmType(SL.rowValue).foregroundStyle(Color.hmMuted)
                }
                if chevron {
                    Icon(.chevronRight, size: DesignTokens.IconSize.chevron).foregroundStyle(Color.hmMuted)
                }
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if !last { RowSeparator() }
        }
        .contentShape(Rectangle())
    }
}

struct PrivacyPage: View {
    let memory: MemoryStore
    let listening: (any HerListening)?
    let openListening: () -> Void
    let openSenses: (() -> Void)?
    var sensesSummary: String? = nil
    let back: () -> Void
    @State private var failed = false
    @State private var forgetVoiceprint = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.privacy, leading: .back, action: back)
            if let openSenses {
                SettingsGroup(label: nil) {
                    Button(action: openSenses) {
                        HerRow(icon: .eye, title: M.letHerSense, subtitle: sensesSummary, last: true)
                    }
                    .buttonStyle(.plain)
                }
            }
            if let overview = memory.overview {
                SettingsGroup(label: M.memoryTitle) {
                    SettingsRow(
                        icon: nil,
                        title: M.pauseMemory,
                        detail: M.pauseMemoryDetail,
                        switchState: Binding(get: { overview.capturePaused }, set: { setPaused($0) }),
                        last: true
                    )
                }
            }
            if let listening {
                SettingsGroup(label: nil) {
                    Button {
                        if listening.hasVoiceprint { forgetVoiceprint = true } else { openListening() }
                    } label: {
                        SettingsRow(
                            icon: nil,
                            title: M.voiceprint,
                            detail: M.voiceprintDetail,
                            value: listening.hasVoiceprint ? M.voiceprintKept : M.voiceprintNone,
                            chevron: true,
                            last: true
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .confirmationDialog(M.forgetVoiceprint, isPresented: $forgetVoiceprint, titleVisibility: .visible) {
            Button(M.forgetVoiceprintConfirm, role: .destructive) { listening?.deleteVoiceprint() }
        } message: {
            Text(M.forgetVoiceprintDetail)
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func setPaused(_ paused: Bool) {
        Task {
            do {
                try await memory.setCapturePaused(paused, reason: paused ? M.pauseMemory : M.resumeMemory)
            } catch {
                failed = true
            }
        }
    }
}
