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
        case personalization
        case notificationsHub
        case notifications
        case voice
        case dataAndApps
        case sense(SenseItem)
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
        case yourData
        case exportData
        case importData
        case importPaste
        case importPreview
        case files
        case talkTiming
    }

    @State private var settings: SettingsStore
    @State private var heroScrolledAway = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var memory: MemoryStore
    @State private var quietHours: QuietHoursStore
    @State private var timers: TimersStore
    @State private var personal: PersonalStore
    @State private var files: OwnerFilesStore
    @State private var connections: ConnectionsStore
    @State private var agents: AgentsStore
    @State private var gmail: GmailStore
    @State private var dataExport: DataExportStore
    @State private var memoryImport: MemoryImportStore
    @State private var serverStatus: ServerStatusStore
    @State private var path: [Page]
    @State private var vaultCount: HerVaultCount = .unknown
    @State private var vaultOpen = false
    @State private var deletionOpen = false
    private let listening: (any HerListening)?
    private let actions: DeviceActionsModel?
    private let openListening: () -> Void
    private let openVoiceprint: () -> Void
    private let senses: HerSenses?
    private let perceptionDeletion: ((@escaping () -> Void) -> AnyView)?
    private let talk: (String) -> Void
    private let close: () -> Void
    private let removedThisDevice: () -> Void
    private let unsentMessages: () -> Int?
    private var highlightsDevice: String?
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
        senses: HerSenses? = nil,
        perceptionDeletion: ((@escaping () -> Void) -> AnyView)? = nil,
        talk: @escaping (String) -> Void,
        close: @escaping () -> Void,
        removedThisDevice: @escaping () -> Void,
        unsentMessages: @escaping () -> Int? = { nil },
        opensDevices: Bool = false,
        highlightsDevice: String? = nil
    ) {
        _path = State(initialValue: opensDevices ? [.devices] : [])
        self.highlightsDevice = highlightsDevice
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        server = api.http.currentCredentials?.origin.absoluteString
        _settings = State(initialValue: SettingsStore(directory: SignedDeviceDirectory(http: api.http, confirmKey: confirmKey)))
        _memory = State(initialValue: MemoryStore(gateway: gateway))
        _quietHours = State(initialValue: QuietHoursStore(gateway: gateway))
        _timers = State(initialValue: TimersStore(gateway: gateway))
        _personal = State(initialValue: PersonalStore(gateway: gateway, loadModels: { try? await api.configuration().chatModels }))
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
        self.talk = talk
        self.close = close
        self.removedThisDevice = removedThisDevice
        self.unsentMessages = unsentMessages
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

    init(settings: SettingsStore, memory: MemoryStore, quietHours: QuietHoursStore, timers: TimersStore? = nil, connections: ConnectionsStore? = nil, agents: AgentsStore? = nil, gmail: GmailStore? = nil, personal: PersonalStore? = nil, files: OwnerFilesStore? = nil, gateway: ManageGateway? = nil, memoryImport: MemoryImportStore? = nil, listening: (any HerListening)? = nil, actions: DeviceActionsModel? = nil, senses: HerSenses? = nil, perceptionDeletion: AnyView? = nil, vault: AnyView? = nil, vaultItems: HerVaultCount = .items(3), path: [Page] = []) {
        _settings = State(initialValue: settings)
        _memory = State(initialValue: memory)
        _quietHours = State(initialValue: quietHours)
        _timers = State(initialValue: timers ?? TimersStore(timers: nil))
        let demoGateway = gateway ?? ManageGateway(transport: NoTransport())
        _personal = State(initialValue: personal ?? PersonalStore(gateway: demoGateway, loadModels: { nil }))
        _files = State(initialValue: files ?? OwnerFilesStore(files: nil))
        _connections = State(initialValue: connections ?? ConnectionsStore(connections: nil))
        _agents = State(initialValue: agents ?? AgentsStore(agents: nil))
        _gmail = State(initialValue: gmail ?? GmailStore(overview: nil))
        _dataExport = State(initialValue: DataExportStore(gateway: demoGateway, download: { _ in Data() }))
        _memoryImport = State(initialValue: memoryImport ?? MemoryImportStore(gateway: demoGateway))
        _serverStatus = State(initialValue: ServerStatusStore(gateway: demoGateway))
        _path = State(initialValue: path)
        self.listening = listening
        self.actions = actions
        openListening = {}
        openVoiceprint = {}
        self.senses = senses
        self.perceptionDeletion = perceptionDeletion.map { shown in { _ in shown } }
        talk = { _ in }
        close = {}
        removedThisDevice = {}
        unsentMessages = { 0 }
        let shown = vaultItems
        countVault = { shown }
        server = "https://himawari.example"
        self.vault = vault.map { shown in { _ in shown } }
        voiceTimings = { [] }
    }

    public var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    HerHero()
                        .scrollTransition(.interactive, axis: .vertical) { hero, phase in
                            hero
                                .scaleEffect(phase.value < 0 ? 1 + phase.value / 2 : 1, anchor: .top)
                                .opacity(phase.value < 0 ? 1 + phase.value : 1)
                        }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                if let actions, actions.waitingCount > 0 {
                    Section {
                        NavigationLink(value: Page.approvals) {
                            HerLinkLabel(title: M.approvalsWaiting(actions.waitingCount), icon: .hourglass)
                        }
                    }
                }
                ForEach(HerEntryGroup.allCases, id: \.self) { group in
                    let shown = HerEntry.entries(in: group).filter { isAvailable($0) }
                    if !shown.isEmpty {
                        Section {
                            ForEach(shown, id: \.self) { entry in
                                row(entry)
                            }
                        }
                    }
                }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top > DesignTokens.Her.heroPaddingTop + DesignTokens.Her.heroAvatar
            } action: { _, away in
                withAnimation(reduceMotion ? nil : .easeInOut) { heroScrolledAway = away }
            }
            .refreshable { await load() }
            .herList(M.herPage)
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
                destination(page)
            }
        }
        .task { await load() }
        .sheet(isPresented: $deletionOpen) {
            perceptionDeletion?({ deletionOpen = false })
        }
        .sheet(isPresented: $vaultOpen, onDismiss: { Task { vaultCount = await countVault() } }) {
            vault?({ vaultOpen = false })
        }
    }

    @ViewBuilder
    private func row(_ entry: HerEntry) -> some View {
        if entry == .passwords {
            Button { vaultOpen = true } label: {
                HerButtonLabel(title: entry.title, icon: entry.icon)
            }
        } else if let page = page(entry) {
            NavigationLink(value: page) {
                HerLinkLabel(title: entry.title, icon: entry.icon)
            }
        }
    }

    private func page(_ entry: HerEntry) -> Page? {
        switch entry {
        case .files: .files
        case .personalization: .personalization
        case .notifications: .notificationsHub
        case .voice: .voice
        case .dataAndApps: .dataAndApps
        case .passwords: nil
        case .noMoreAsking: .allowances
        case .yourData: .yourData
        case .devices: .devices
        case .about: .about
        }
    }

    private func isAvailable(_ entry: HerEntry) -> Bool {
        switch entry {
        case .files: files.phase != .unsupported
        case .personalization, .noMoreAsking, .yourData, .devices, .about: true
        case .notifications: timers.phase != .unsupported || quietHours.hours != nil
        case .voice: listening != nil
        case .dataAndApps: connections.phase == .loaded || agents.phase == .loaded || actions != nil || senses != nil
        case .passwords: vault != nil && vaultCount != .unsupported
        }
    }

    @ViewBuilder
    private func destination(_ page: Page) -> some View {
        switch page {
        case .personalization:
            PersonalizationPage(personal: personal)
        case .notificationsHub:
            NotificationsHubPage(timers: timers, quietHours: quietHours)
        case .voice:
            if let listening {
                VoicePage(listening: listening, openListening: openListening, openVoiceprint: openVoiceprint)
            }
        case .dataAndApps:
            DataAndAppsPage(connections: connections, agents: agents, actions: actions, senses: senses)
        case .sense(let item):
            if let senses {
                senses.screen(item) { path.removeLast() }
            }
        case .yourData:
            YourDataPage(openDeletion: perceptionDeletion == nil ? nil : { deletionOpen = true })
        case .memory:
            MemoryRootView(store: memory, talk: talk)
        case .rules:
            RulesPage(store: memory, quietHours: quietHours.hours, talk: talk)
        case .notifications:
            NotificationsPage(store: quietHours) { path.removeLast() }
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
            HerDevicesPage(store: settings, unsentMessages: unsentMessages, removedThisDevice: removedThisDevice, highlighted: highlightsDevice)
        case .device(let id):
            DevicePage(store: settings, deviceId: id, actions: actions, unsentMessages: unsentMessages, removedThisDevice: removedThisDevice) { path.removeLast() }
        case .allowances:
            HerAllowancesPage(memory: memory) { path.removeLast() }
        case .timers:
            TimersPage(store: timers, open: { path.append(.timer($0)) }) { path.removeLast() }
        case .timer(let id):
            TimerDetailPage(store: timers, timerId: id) { path.removeLast() }
        case .about:
            AboutPage(server: server, openStatus: { path.append(.serverStatus) }) { path.removeLast() }
        case .serverStatus:
            ServerStatusPage(store: serverStatus) { path.removeLast() }
        case .exportData:
            DataTransferPage(export: dataExport, importer: memoryImport, part: .export, openPaste: {}, openPreview: {}) { path.removeLast() }
        case .importData:
            DataTransferPage(
                export: dataExport,
                importer: memoryImport,
                part: .importing,
                openPaste: { path.append(.importPaste) },
                openPreview: { path.append(.importPreview) }
            ) { path.removeLast() }
        case .importPaste:
            MemoryImportPastePage(store: memoryImport, openPreview: { path.append(.importPreview) }) { path.removeLast() }
        case .importPreview:
            MemoryImportPreviewPage(store: memoryImport, finish: finishImport) { path.removeLast() }
        case .files:
            FilesPage(store: files)
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

    private func finishImport() {
        memoryImport.reset()
        path.removeAll { $0 == .importPreview || $0 == .importPaste }
        Task { await memory.load() }
    }

    private func load() async {
        async let settingsLoaded: Void = settings.load()
        async let memoryLoaded: Void = memory.load()
        async let quietLoaded: Void = quietHours.load()
        async let timersLoaded: Void = timers.load()
        async let filesLoaded: Void = files.load()
        async let personalLoaded: Void = personal.load()
        async let connectionsLoaded: Void = connections.load()
        async let agentsLoaded: Void = agents.load()
        await actions?.refreshPermissions()
        vaultCount = await countVault()
        _ = await (settingsLoaded, memoryLoaded, quietLoaded, timersLoaded, personalLoaded, filesLoaded, connectionsLoaded, agentsLoaded)
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
