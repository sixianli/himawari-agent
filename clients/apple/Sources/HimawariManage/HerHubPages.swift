import HimawariCore
import HimawariDesign
import SwiftUI

public struct HerSenses {
    let items: [SenseItem]
    let opens: @MainActor (SenseItem) -> Bool
    let label: @MainActor (SenseItem) -> AnyView
    let screen: @MainActor (SenseItem, @escaping () -> Void) -> AnyView
    let refresh: @MainActor () async -> Void
    let handover: AnyView?

    public init(
        items: [SenseItem],
        opens: @escaping @MainActor (SenseItem) -> Bool,
        label: @escaping @MainActor (SenseItem) -> AnyView,
        screen: @escaping @MainActor (SenseItem, @escaping () -> Void) -> AnyView,
        refresh: @escaping @MainActor () async -> Void,
        handover: AnyView? = nil
    ) {
        self.items = items
        self.opens = opens
        self.label = label
        self.screen = screen
        self.refresh = refresh
        self.handover = handover
    }
}

struct HerLinkLabel: View {
    let title: String
    var icon: IconName? = nil
    var value: String? = nil

    var body: some View {
        LabeledContent {
            if let value {
                Text(value).foregroundStyle(Color.hmMuted)
            }
        } label: {
            if let icon {
                Label {
                    Text(title).foregroundStyle(Color.hmText)
                } icon: {
                    Icon(icon, size: DesignTokens.IconSize.listRow)
                        .foregroundStyle(Color.hmGlyph)
                }
            } else {
                Text(title).foregroundStyle(Color.hmText)
            }
        }
        .contentShape(Rectangle())
    }
}

struct HerButtonLabel: View {
    let title: String
    var icon: IconName? = nil
    var value: String? = nil

    var body: some View {
        HStack {
            HerLinkLabel(title: title, icon: icon, value: value)
            Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                .foregroundStyle(Color.hmMuted)
        }
    }
}

extension View {
    func herList(_ title: String) -> some View {
        scrollContentBackground(.hidden)
            .timersListStyle()
            .tint(Color.hmSun)
            .himawariScreenBackground()
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
    }
}

struct PersonalizationPage: View {
    let personal: PersonalStore

    var body: some View {
        List {
            Section {
                if personal.phase == .loaded {
                    NavigationLink(value: HerPage.Page.name) {
                        HerLinkLabel(title: M.nameRow, value: personal.name ?? M.nameUnset)
                    }
                }
                NavigationLink(value: HerPage.Page.rules) {
                    HerLinkLabel(title: M.rules)
                }
                if personal.canChooseModel, let model = personal.chosenModel {
                    NavigationLink(value: HerPage.Page.model) {
                        HerLinkLabel(title: M.modelRow, value: M.modelName(model))
                    }
                }
                NavigationLink(value: HerPage.Page.memory) {
                    HerLinkLabel(title: M.memoryTitle)
                }
            }
        }
        .herList(M.personalizationTitle)
    }
}

struct NotificationsHubPage: View {
    let timers: TimersStore
    let quietHours: QuietHoursStore

    var body: some View {
        List {
            Section {
                if timers.phase != .unsupported {
                    NavigationLink(value: HerPage.Page.timers) {
                        HerLinkLabel(title: M.timersTitle)
                    }
                }
                if quietHours.hours != nil {
                    NavigationLink(value: HerPage.Page.notifications) {
                        HerLinkLabel(title: M.quietTitle)
                    }
                }
            }
        }
        .herList(M.notificationsTitle)
    }
}

struct VoicePage: View {
    let listening: any HerListening
    let openListening: () -> Void
    let openVoiceprint: () -> Void
    @AppStorage(AboutPage.developerModeKey) private var developerMode = false
    @State private var forgetVoiceprint = false

    var body: some View {
        List {
            Section {
                Toggle(isOn: Binding(get: { listening.isListening }, set: { on in
                    if on { openListening() } else { listening.stop() }
                })) {
                    Text(M.listenAlways).foregroundStyle(Color.hmText)
                }
                Button {
                    if listening.hasVoiceprint { forgetVoiceprint = true } else { openVoiceprint() }
                } label: {
                    HerButtonLabel(title: M.voiceprint, value: listening.hasVoiceprint ? M.voiceprintKept : M.voiceprintNone)
                }
            }
            if developerMode {
                Section {
                    NavigationLink(value: HerPage.Page.talkTiming) {
                        HerLinkLabel(title: M.talkTiming)
                    }
                }
            }
        }
        .herList(M.voiceTitle)
        .confirmationDialog(M.forgetVoiceprint, isPresented: $forgetVoiceprint, titleVisibility: .visible) {
            Button(M.forgetVoiceprintConfirm, role: .destructive) { listening.deleteVoiceprint() }
        } message: {
            Text(M.forgetVoiceprintDetail)
        }
    }
}

struct DataAndAppsPage: View {
    let connections: ConnectionsStore
    let agents: AgentsStore
    let actions: DeviceActionsModel?
    let senses: HerSenses?
    @State private var primer: PermissionState?

    private enum Local: Hashable {
        case sense(SenseItem)
        case permission(String)
    }

    var body: some View {
        List {
            if !local.isEmpty {
                Section(M.onThisIPhone) {
                    ForEach(local, id: \.self) { entry in
                        row(entry)
                    }
                }
            }
            if let handover = senses?.handover {
                handover
            }
            if connections.phase == .loaded {
                Section(M.accountsAndApps) {
                    ForEach(connections.shown) { connection in
                        NavigationLink(value: connection.name == GmailStore.source ? HerPage.Page.gmail : HerPage.Page.app(connection.name)) {
                            HerLinkLabel(title: connection.title, icon: connection.name == GmailStore.source ? .mail : .puzzle, value: Self.summary(connection))
                        }
                    }
                    NavigationLink(value: HerPage.Page.addApp) {
                        HerLinkLabel(title: M.connectionAdd, icon: .plus)
                    }
                }
            }
            if agents.phase == .loaded {
                Section(M.otherAgents) {
                    if agents.shown.isEmpty {
                        Text(M.agentsEmpty).foregroundStyle(Color.hmMuted)
                    }
                    ForEach(agents.shown) { agent in
                        NavigationLink(value: HerPage.Page.agent(agent.id)) {
                            HerLinkLabel(title: agent.name, icon: .affiliate)
                        }
                    }
                }
            }
        }
        .herList(M.dataAndAppsTitle)
        .refreshable { await reload() }
        .task { await reload() }
        .sheet(item: $primer) { permission in
            PermissionPrimerView(permission: permissions.first { $0.id == permission.id } ?? permission) {
                Task { await actions?.request(permission.id) }
            } close: {
                primer = nil
            }
            .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder
    private func row(_ entry: Local) -> some View {
        switch entry {
        case .sense(let item):
            if let senses {
                if senses.opens(item) {
                    NavigationLink(value: HerPage.Page.sense(item)) { senses.label(item) }
                } else {
                    senses.label(item)
                }
            }
        case .permission(let id):
            if let permission = permissions.first(where: { $0.id == id }) {
                Button { primer = permission } label: {
                    HerButtonLabel(title: permission.name, icon: Self.icon(id), value: L.text("permission.status.\(permission.status.rawValue)"))
                }
            }
        }
    }

    private var permissions: [PermissionState] { actions?.permissions ?? [] }

    private var local: [Local] {
        let order: [Local] = [
            .sense(.calendar), .permission("reminders"), .sense(.contacts), .sense(.health),
            .sense(.location), .sense(.photos), .sense(.clipboard),
        ]
        return order.compactMap { entry -> Local? in
            switch entry {
            case .sense(let item):
                if let senses { return senses.items.contains(item) ? entry : nil }
                let fallback = item == .calendar ? "calendar" : item == .contacts ? "contacts" : nil
                guard let fallback, permissions.contains(where: { $0.id == fallback }) else { return nil }
                return .permission(fallback)
            case .permission(let id):
                return permissions.contains { $0.id == id } ? entry : nil
            }
        }
    }

    private func reload() async {
        async let listed: Void = connections.load()
        async let agentsListed: Void = agents.load()
        await actions?.refreshPermissions()
        await senses?.refresh()
        _ = await (listed, agentsListed)
    }

    private static func icon(_ id: String) -> IconName {
        switch id {
        case "calendar": .calendar
        case "reminders": .listCheck
        default: .addressBook
        }
    }

    static func summary(_ connection: AppConnection) -> String {
        switch connection.status {
        case "connected": connection.account ?? M.connectionConnected
        case "needs_reconnect": M.connectionExpired
        default: M.gmailNotConnected
        }
    }
}

struct YourDataPage: View {
    let openDeletion: (() -> Void)?

    var body: some View {
        List {
            Section {
                NavigationLink(value: HerPage.Page.exportData) {
                    HerLinkLabel(title: M.exportAction)
                }
                NavigationLink(value: HerPage.Page.importData) {
                    HerLinkLabel(title: M.importGroup)
                }
                if let openDeletion {
                    Button(action: openDeletion) {
                        HerButtonLabel(title: M.deleteRecords)
                    }
                }
            }
        }
        .herList(M.yourDataTitle)
    }
}
