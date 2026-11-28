import HimawariCore
import HimawariDesign
import SwiftUI

@MainActor
public protocol HerListening: AnyObject, Sendable {
    var hasVoiceprint: Bool { get }
    var isListening: Bool { get }
    func deleteVoiceprint()
    func stop()
}

public enum HerVaultCount: Equatable, Sendable {
    case unsupported
    case unknown
    case items(Int)
}

public struct HerPage: View {
    enum Page: Hashable {
        case memory
        case rules
        case notifications
        case privacy
        case connections
        case agents
        case agent(String)
        case gmail
        case app(String)
        case addApp
        case devices
        case device(String)
        case approvals
        case allowances
        case timers
        case timer(String)
        case about
        case name
        case model
        case serverStatus
        case transfer
        case importPaste
        case importPreview
        case files
        case evaluation
        case talkTiming
        case settings
    }

    @State private var settings: SettingsStore
    @State private var heroScrolledAway = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var memory: MemoryStore
    @State private var quietHours: QuietHoursStore
    @State private var timers: TimersStore
    @State private var personal: PersonalStore
    @State private var stats: DecisionStatsStore
    @State private var files: OwnerFilesStore
    @State private var connections: ConnectionsStore
    @State private var agents: AgentsStore
    @State private var gmail: GmailStore
    @State private var dataExport: DataExportStore
    @State private var memoryImport: MemoryImportStore
    @State private var serverStatus: ServerStatusStore
    @State private var path: [Page] = []
    @State private var sensesOpen = false
    @State private var vaultCount: HerVaultCount = .unknown
    @State private var vaultOpen = false
    @State private var deletionOpen = false
    private let listening: (any HerListening)?
    private let actions: DeviceActionsModel?
    private let openListening: () -> Void
    private let openVoiceprint: () -> Void
    private let senses: AnyView?
    private let perceptionDeletion: ((@escaping () -> Void) -> AnyView)?
    private let sensesOn: () -> Int?
    private let talk: (String) -> Void
    private let close: () -> Void
    private let removedThisDevice: () -> Void
    private let countVault: () async -> HerVaultCount
    private let vault: ((@escaping () -> Void) -> AnyView)?
    private let voiceTimings: @Sendable () async throws -> [VoiceTimingRecord]
    private let server: String?

    public init(
        api: DeviceAPI,
        confirmKey: DeviceKeySigner,
        listening: (any HerListening)? = nil,
        actions: DeviceActionsModel? = nil,
        openListening: @escaping () -> Void = {},
        openVoiceprint: @escaping () -> Void = {},
        senses: AnyView? = nil,
        perceptionDeletion: ((@escaping () -> Void) -> AnyView)? = nil,
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
        _timers = State(initialValue: TimersStore(gateway: gateway))
        _personal = State(initialValue: PersonalStore(gateway: gateway, loadModels: { try? await api.configuration().chatModels }))
        _stats = State(initialValue: DecisionStatsStore(gateway: gateway))
        _files = State(initialValue: OwnerFilesStore(gateway: gateway, api: api))
        _connections = State(initialValue: ConnectionsStore(gateway: gateway))
        _agents = State(initialValue: AgentsStore(gateway: gateway))
        _gmail = State(initialValue: GmailStore(gateway: gateway))
        _dataExport = State(initialValue: DataExportStore(gateway: gateway, download: { try await api.dataExportArchive(exportId: $0) }))
        _memoryImport = State(initialValue: MemoryImportStore(gateway: gateway))
        _serverStatus = State(initialValue: ServerStatusStore(gateway: gateway))
        self.listening = listening
        self.actions = actions
        self.openListening = openListening
        self.openVoiceprint = openVoiceprint
        self.senses = senses
        self.perceptionDeletion = perceptionDeletion
        self.sensesOn = sensesOn
        self.talk = talk
        self.close = close
        self.removedThisDevice = removedThisDevice
        voiceTimings = { try await api.voiceTimings() }
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

    init(settings: SettingsStore, memory: MemoryStore, quietHours: QuietHoursStore, timers: TimersStore? = nil, connections: ConnectionsStore? = nil, agents: AgentsStore? = nil, gmail: GmailStore? = nil, personal: PersonalStore? = nil, gateway: ManageGateway? = nil, memoryImport: MemoryImportStore? = nil, listening: (any HerListening)? = nil, actions: DeviceActionsModel? = nil, senses: AnyView? = nil, vaultItems: HerVaultCount = .items(3), path: [Page] = []) {
        _settings = State(initialValue: settings)
        _memory = State(initialValue: memory)
        _quietHours = State(initialValue: quietHours)
        _timers = State(initialValue: timers ?? TimersStore(timers: nil))
        _personal = State(initialValue: personal ?? PersonalStore(gateway: settings.gateway, loadModels: { nil }))
        _stats = State(initialValue: DecisionStatsStore(stats: nil))
        _files = State(initialValue: OwnerFilesStore(files: nil))
        _connections = State(initialValue: connections ?? ConnectionsStore(connections: nil))
        _agents = State(initialValue: agents ?? AgentsStore(agents: nil))
        _gmail = State(initialValue: gmail ?? GmailStore(overview: nil))
        let demoGateway = gateway ?? ManageGateway(transport: NoTransport())
        _dataExport = State(initialValue: DataExportStore(gateway: demoGateway, download: { _ in Data() }))
        _memoryImport = State(initialValue: memoryImport ?? MemoryImportStore(gateway: demoGateway))
        _serverStatus = State(initialValue: ServerStatusStore(gateway: demoGateway))
        _path = State(initialValue: path)
        self.listening = listening
        self.actions = actions
        openListening = {}
        openVoiceprint = {}
        self.senses = senses
        perceptionDeletion = senses.map { shown in { _ in shown } }
        sensesOn = { 4 }
        talk = { _ in }
        close = {}
        removedThisDevice = {}
        let shown = vaultItems
        countVault = { shown }
        server = "https://himawari.example"
        vault = nil
        voiceTimings = { [] }
    }

    public var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(spacing: DesignTokens.Her.pageGap) {
                    HerHero()
                        .scrollTransition(.interactive, axis: .vertical) { hero, phase in
                            hero
                                .scaleEffect(phase.value < 0 ? 1 + phase.value / 2 : 1, anchor: .top)
                                .opacity(phase.value < 0 ? 1 + phase.value : 1)
                        }
                    if let actions, actions.waitingCount > 0 {
                        SettingsGroup(label: nil) {
                            Button { path.append(.approvals) } label: {
                                HerRow(icon: .hourglass, title: M.approvalsWaiting(actions.waitingCount), last: true)
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                    SettingsGroup(label: M.herKnows) {
                        Button { path.append(.memory) } label: {
                            HerRow(icon: .brain, title: M.herMemory, subtitle: memory.summary(categoryLabel: M.category).map(M.memorySummary))
                        }
                        .buttonStyle(.pressable)
                        Button { path.append(.rules) } label: {
                            HerRow(icon: .clipboardList, title: M.rules, subtitle: memory.phase == .loaded ? M.rulesSummary(RulesPage.ownPageRules(memory.rules, quietHours: quietHours.hours).count) : nil, last: files.phase == .unsupported && stats.phase == .unsupported)
                        }
                        .buttonStyle(.pressable)
                        if files.phase != .unsupported {
                            Button { path.append(.files) } label: {
                                HerRow(icon: .folder, title: M.filesTitle, last: stats.phase == .unsupported)
                            }
                            .buttonStyle(.pressable)
                        }
                        if stats.phase != .unsupported {
                            Button { path.append(.evaluation) } label: {
                                HerRow(icon: .listCheck, title: M.evalTitle, last: true)
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                    SettingsGroup(label: M.herDoes) {
                        if timers.phase != .unsupported {
                            Button { path.append(.timers) } label: {
                                HerRow(icon: .alarm, title: M.timersTitle, subtitle: timersSummary)
                            }
                            .buttonStyle(.pressable)
                        }
                        if connections.available || actions != nil {
                            Button { path.append(.connections) } label: {
                                HerRow(icon: .puzzle, title: M.connectionsTitle, subtitle: connectionsSummary)
                            }
                            .buttonStyle(.pressable)
                        }
                        if agents.available {
                            Button { path.append(.agents) } label: {
                                HerRow(icon: .affiliate, title: M.agentsTitle, subtitle: M.agentsSummary(agents.shown.map(\.name)))
                            }
                            .buttonStyle(.pressable)
                        }
                        Button { path.append(.allowances) } label: {
                            HerRow(icon: .shieldCheck, title: M.allowancesTitle, subtitle: M.allowancesSummary(memory.allowances.count), last: vaultCount == .unsupported)
                        }
                        .buttonStyle(.pressable)
                        if vaultCount != .unsupported {
                            Button { vaultOpen = true } label: {
                                HerRow(icon: .key, title: M.vaultTitle, subtitle: M.vaultSummary(vaultCount), last: true)
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                    SettingsGroup(label: nil) {
                        Button { path.append(.settings) } label: {
                            HerRow(icon: .settings, title: M.settingsTitle, last: true)
                        }
                        .buttonStyle(.pressable)
                    }
                }
                .padding(.top, 8)
                .padding(.horizontal, DesignTokens.Size.pagePaddingX)
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
            }
            .scrollIndicators(.hidden)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top > DesignTokens.Her.heroPaddingTop + DesignTokens.Her.heroAvatar
            } action: { _, away in
                withAnimation(reduceMotion ? nil : .easeInOut) { heroScrolledAway = away }
            }
            .refreshable { await load() }
            .himawariScreenBackground()
            .navigationTitle(M.herPage)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HerTitle()
                        .opacity(heroScrolledAway ? 1 : 0)
                        .accessibilityHidden(!heroScrolledAway)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(M.done, action: close)
                }
            }
            .navigationDestination(for: Page.self) { page in
                switch page {
                case .settings:
                    settingsPage
                case .memory:
                    MemoryRootView(store: memory, talk: talk)
                case .rules:
                    RulesPage(store: memory, quietHours: quietHours.hours, talk: talk)
                case .notifications:
                    NotificationsPage(store: quietHours) { path.removeLast() }
                case .privacy:
                    PrivacyPage(
                        memory: memory,
                        listening: listening,
                        openListening: openListening,
                        openVoiceprint: openVoiceprint,
                        openSenses: senses == nil ? nil : { sensesOpen = true },
                        openDeletion: perceptionDeletion == nil ? nil : { deletionOpen = true },
                        sensesSummary: sensesOn().map(M.sensesOn)
                    ) { path.removeLast() }
                case .connections:
                    ConnectionsPage(store: connections, actions: actions, openSenses: senses == nil ? nil : { sensesOpen = true }, open: { connection in
                        path.append(connection.name == GmailStore.source ? .gmail : .app(connection.name))
                    }, add: { path.append(.addApp) }) { path.removeLast() }
                case .agents:
                    AgentsPage(store: agents, open: { path.append(.agent($0)) }) { path.removeLast() }
                case .agent(let id):
                    AgentPage(store: agents, agentId: id) { path.removeLast() }
                case .gmail:
                    GmailPage(store: gmail) { path.removeLast() }
                        .onDisappear { Task { await connections.load() } }
                case .app(let name):
                    AppConnectionPage(store: connections, name: name) { path.removeLast() }
                case .addApp:
                    AddAppConnectionPage(store: connections, added: { connection in
                        path.removeLast()
                        path.append(.app(connection.name))
                    }) { path.removeLast() }
                case .devices:
                    HerDevicesPage(store: settings, open: { path.append(.device($0.id)) }, removedThisDevice: removedThisDevice) { path.removeLast() }
                case .device(let id):
                    DevicePage(store: settings, deviceId: id, actions: actions, removedThisDevice: removedThisDevice) { path.removeLast() }
                case .allowances:
                    HerAllowancesPage(memory: memory) { path.removeLast() }
                case .timers:
                    TimersPage(store: timers, open: { path.append(.timer($0)) }) { path.removeLast() }
                case .timer(let id):
                    TimerDetailPage(store: timers, timerId: id) { path.removeLast() }
                case .about:
                    AboutPage(server: server, openStatus: { path.append(.serverStatus) }, openTiming: { path.append(.talkTiming) }) { path.removeLast() }
                case .serverStatus:
                    ServerStatusPage(store: serverStatus) { path.removeLast() }
                case .transfer:
                    DataTransferPage(
                        export: dataExport,
                        importer: memoryImport,
                        openPaste: { path.append(.importPaste) },
                        openPreview: { path.append(.importPreview) }
                    ) { path.removeLast() }
                case .importPaste:
                    MemoryImportPastePage(store: memoryImport, openPreview: { path.append(.importPreview) }) { path.removeLast() }
                case .importPreview:
                    MemoryImportPreviewPage(store: memoryImport, finish: finishImport) { path.removeLast() }
                case .files:
                    FilesPage(store: files)
                case .evaluation:
                    EvaluationPage(store: stats)
                case .talkTiming:
                    TalkTimingPage(load: voiceTimings)
                case .name:
                    NamePage(store: personal) { path.removeLast() }
                case .model:
                    ModelPage(store: personal) { path.removeLast() }
                case .approvals:
                    if let actions {
                        ApprovalsView(model: actions, openThread: { _ in close() }) { path.removeLast() }
                    }
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $sensesOpen) {
            senses
        }
        .sheet(isPresented: $deletionOpen) {
            perceptionDeletion?({ deletionOpen = false })
        }
        .sheet(isPresented: $vaultOpen, onDismiss: { Task { vaultCount = await countVault() } }) {
            vault?({ vaultOpen = false })
        }
    }

    private var settingsPage: some View {
        ScrollView {
            VStack(spacing: DesignTokens.Her.pageGap) {
                SettingsGroup(label: nil) {
                    if personal.phase == .loaded {
                        Button { path.append(.name) } label: {
                            HerRow(icon: .user, title: M.nameTitle, value: personal.name ?? M.nameUnset)
                        }
                        .buttonStyle(.pressable)
                    }
                    if personal.canChooseModel, let model = personal.chosenModel {
                        Button { path.append(.model) } label: {
                            HerRow(icon: .bulb, title: M.modelTitle, value: M.modelName(model))
                        }
                        .buttonStyle(.pressable)
                    }
                    if let hours = quietHours.hours {
                        Button { path.append(.notifications) } label: {
                            HerRow(icon: .bell, title: M.notificationsTitle, subtitle: M.quietSummary(hours))
                        }
                        .buttonStyle(.pressable)
                    }
                    Button { path.append(.privacy) } label: {
                        HerRow(icon: .handStop, title: M.privacy)
                    }
                    .buttonStyle(.pressable)
                    Button { path.append(.devices) } label: {
                        HerRow(icon: .deviceMobilePlain, title: M.devicesTitle, subtitle: devicesSummary, last: true)
                    }
                    .buttonStyle(.pressable)
                }
                SettingsGroup(label: nil) {
                    Button { path.append(.transfer) } label: {
                        HerRow(icon: .download, title: M.transferTitle)
                    }
                    .buttonStyle(.pressable)
                    Button { path.append(.about) } label: {
                        HerRow(icon: .infoCircle, title: M.aboutTitle, subtitle: AboutPage.versionLine, last: true)
                    }
                    .buttonStyle(.pressable)
                }
            }
            .padding(.top, 8)
            .padding(.horizontal, DesignTokens.Size.pagePaddingX)
            .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        }
        .scrollIndicators(.hidden)
        .himawariScreenBackground()
        .navigationTitle(M.settingsTitle)
    }

    private func finishImport() {
        memoryImport.reset()
        path.removeAll { $0 == .importPreview || $0 == .importPaste }
        Task { await memory.load() }
    }

    private var timersSummary: String? {
        guard timers.phase == .loaded else { return nil }
        let counts = timers.counts
        return M.timersSummary(active: counts.active, paused: counts.paused)
    }

    private var connectionsSummary: String {
        if connections.needsReconnect { return M.connectionExpired }
        let titles = connections.connectedTitles
        return titles.isEmpty ? M.connectionsNoneConnected : titles.formatted(.list(type: .and))
    }

    private var devicesSummary: String? {
        guard settings.phase == .loaded, settings.devices.contains(where: settings.isThisDevice) else { return nil }
        return M.thisIPhone
    }

    private func load() async {
        async let settingsLoaded: Void = settings.load()
        async let memoryLoaded: Void = memory.load()
        async let quietLoaded: Void = quietHours.load()
        async let timersLoaded: Void = timers.load()
        async let statsLoaded: Void = stats.load(.week)
        async let filesLoaded: Void = files.load()
        async let personalLoaded: Void = personal.load()
        async let connectionsLoaded: Void = connections.load()
        async let agentsLoaded: Void = agents.load()
        await actions?.refreshPermissions()
        vaultCount = await countVault()
        _ = await (settingsLoaded, memoryLoaded, quietLoaded, timersLoaded, personalLoaded, statsLoaded, filesLoaded, connectionsLoaded, agentsLoaded)
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
                    .environment(\.colorScheme, .dark)
            }
            Wordmark(size: DesignTokens.Her.heroWordmarkSize)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, DesignTokens.Her.heroPaddingTop)
        .padding(.bottom, DesignTokens.Her.heroPaddingBottom)
    }
}

struct HerTitle: View {
    var body: some View {
        HStack(spacing: DesignTokens.Her.heroGap) {
            SunflowerMark()
                .frame(width: DesignTokens.IconSize.listRow, height: DesignTokens.IconSize.listRow)
            Wordmark(size: DesignTokens.TypeScale.navTitle.size)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(M.herPage))
        .accessibilityAddTraits(.isHeader)
    }
}

struct HerRow: View {
    let icon: IconName
    let title: String
    var subtitle: String? = nil
    var value: String? = nil
    var chevron = true
    var last = false
    @ScaledMetric(relativeTo: .body) private var symbolWidth = DesignTokens.Her.rowSymbolWidth

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                Icon(icon, size: DesignTokens.Her.rowSymbolWidth)
                    .foregroundStyle(Color.hmGlyph)
                    .frame(width: symbolWidth)
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
    let openVoiceprint: () -> Void
    let openSenses: (() -> Void)?
    var openDeletion: (() -> Void)? = nil
    var sensesSummary: String? = nil
    let back: () -> Void
    @State private var failed = false
    @State private var forgetVoiceprint = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.privacy, leading: .back, action: back)
            if openSenses != nil || openDeletion != nil {
                SettingsGroup(label: nil) {
                    if let openSenses {
                        Button(action: openSenses) {
                            HerRow(icon: .eye, title: M.letHerSense, subtitle: sensesSummary, last: openDeletion == nil)
                        }
                        .buttonStyle(.pressable)
                    }
                    if let openDeletion {
                        Button(action: openDeletion) {
                            HerRow(icon: .trash, title: M.deletePerception, last: true)
                        }
                        .buttonStyle(.pressable)
                    }
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
                    SettingsRow(
                        icon: nil,
                        title: M.listenAlways,
                        detail: M.listenAlwaysDetail,
                        switchState: Binding(get: { listening.isListening }, set: { on in
                            if on { openListening() } else { listening.stop() }
                        })
                    )
                    Button {
                        if listening.hasVoiceprint { forgetVoiceprint = true } else { openVoiceprint() }
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
                    .buttonStyle(.pressable)
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
