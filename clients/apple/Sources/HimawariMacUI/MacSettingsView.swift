#if os(macOS)
import AppKit
import HimawariCore
import HimawariDesign
import SwiftUI
import UniformTypeIdentifiers

struct MacSettingsView: View {
    let store: MacSettingsStore
    let shortcutState: GlobalShortcut.State?
    @State private var recording = false
    @State private var recordingProblem = false
    @State private var monitor: Any?

    var scrolls = true

    var body: some View {
        Group {
            if scrolls {
                ScrollView { content }
                    .frame(width: DesignTokens.Mac.settingsWidth, height: DesignTokens.Mac.settingsHeight)
            } else {
                content.frame(width: DesignTokens.Mac.settingsWidth)
            }
        }
        .background(Color.hmBackground)
        .onAppear { store.refreshPermissions() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in store.refreshPermissions() }
        .onDisappear(perform: stopRecording)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Mac.buttonGap) {
            header("settings.folders")
            VStack(spacing: 0) {
                ForEach(store.settings.folders) { grant in
                    folderRow(grant)
                }
                row(icon: .plus) {
                    Button(L.text("settings.folder.add"), action: addFolders)
                        .buttonStyle(.pressable)
                        .foregroundStyle(Color.hmSun)
                } trailing: { EmptyView() }
            }
            header("settings.apps")
            VStack(spacing: 0) {
                ForEach(store.settings.apps) { app in
                    row(icon: .appWindow) {
                        Text(app.name).foregroundStyle(Color.hmText)
                    } trailing: {
                        Button(L.text("settings.apps.remove")) { store.removeApp(app.bundleId) }
                            .buttonStyle(.pressable)
                            .foregroundStyle(Color.hmMuted)
                    }
                }
                row(icon: .plus) {
                    Button(L.text("settings.apps.add"), action: addApps)
                        .buttonStyle(.pressable)
                        .foregroundStyle(Color.hmSun)
                } trailing: {
                    tag(store.settings.apps.isEmpty ? L.text("settings.apps.none") : L.format("settings.apps.count", store.settings.apps.count))
                }
            }
            header("settings.sees")
            VStack(spacing: 0) {
                row(icon: .eye) {
                    VStack(alignment: .leading, spacing: DesignTokens.Mac.statusBadgeGap) {
                        Text(L.text("settings.sees.frontmost")).foregroundStyle(Color.hmText)
                        if store.settings.seesFrontmost && !store.accessibilityAllowed {
                            permissionHint("settings.sees.needsAccessibility", button: "settings.sees.openAccessibility", anchor: "Privacy_Accessibility")
                        }
                    }
                } trailing: {
                    Toggle("", isOn: Binding(get: { store.settings.seesFrontmost }, set: { store.setSeesFrontmost($0) }))
                        .toggleStyle(.switch)
                        .labelsHidden()
                }
                row(icon: .message, alignment: store.settings.seesMessages && !store.messagesReadable ? .top : .center) {
                    VStack(alignment: .leading, spacing: DesignTokens.Mac.statusBadgeGap) {
                        Text(L.text("settings.sees.messages")).foregroundStyle(Color.hmText)
                        if store.settings.seesMessages {
                            messagesStatus
                        }
                    }
                } trailing: {
                    Toggle("", isOn: Binding(get: { store.settings.seesMessages }, set: { store.setSeesMessages($0) }))
                        .toggleStyle(.switch)
                        .labelsHidden()
                }
            }
            header("settings.shortcut")
            row(icon: .settings) {
                VStack(alignment: .leading, spacing: DesignTokens.Mac.statusBadgeGap) {
                    Text(recording ? L.text("settings.shortcut.record") : GlobalShortcut.label(store.settings.shortcut))
                        .foregroundStyle(Color.hmText)
                    if recordingProblem {
                        Text(L.text("settings.shortcut.needsModifier"))
                            .hmType(DesignTokens.TypeScale.macSmall)
                            .foregroundStyle(Color.hmDanger)
                    } else if case .taken = shortcutState {
                        Text(L.text("settings.shortcut.taken"))
                            .hmType(DesignTokens.TypeScale.macSmall)
                            .foregroundStyle(Color.hmDanger)
                    }
                }
            } trailing: {
                Button(recording ? L.text("pairing.cancel") : L.text("settings.shortcut.record")) { recording ? stopRecording() : startRecording() }
                    .buttonStyle(MacButtonStyle(role: .secondary, height: DesignTokens.Mac.smallButtonHeight, small: true))
            }
        }
        .padding(.horizontal, DesignTokens.Mac.settingsPaddingX)
        .padding(.vertical, DesignTokens.Mac.inputChipsTop)
    }

    private func header(_ key: String) -> some View {
        Text(L.text(key))
            .hmType(DesignTokens.TypeScale.macLabel)
            .foregroundStyle(Color.hmMuted)
            .padding(.top, DesignTokens.Mac.statusBadgeGap)
    }

    private func tag(_ text: String) -> some View {
        Text(text).hmType(DesignTokens.TypeScale.macSmall).foregroundStyle(Color.hmMuted)
    }

    private func row<Leading: View, Trailing: View>(icon: IconName, alignment: VerticalAlignment = .center, @ViewBuilder _ leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: alignment, spacing: DesignTokens.Mac.panelGap) {
                Icon(icon, size: DesignTokens.Mac.settingsIcon).foregroundStyle(Color.hmMuted)
                leading()
                    .hmType(DesignTokens.TypeScale.macSetting)
                    .frame(maxWidth: .infinity, alignment: .leading)
                trailing()
                    .hmType(DesignTokens.TypeScale.macSmall)
            }
            .padding(.vertical, DesignTokens.Mac.settingsRowPadding)
            Divider().overlay(Color.hmSeparator)
        }
    }

    private func folderRow(_ grant: FolderGrant) -> some View {
        row(icon: .folder) {
            VStack(alignment: .leading, spacing: DesignTokens.Mac.statusBadgeGap) {
                Text(FileManager.default.displayName(atPath: grant.path)).foregroundStyle(Color.hmText)
                Text(store.folderExists(grant) ? (grant.path as NSString).abbreviatingWithTildeInPath : L.text("settings.folder.missing"))
                    .hmType(DesignTokens.TypeScale.macSmall)
                    .foregroundStyle(store.folderExists(grant) ? Color.hmMuted : Color.hmDanger)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        } trailing: {
            Menu {
                Picker("", selection: Binding(get: { grant.access }, set: { store.setAccess($0, for: grant.id) })) {
                    Text(L.text("settings.folder.read")).tag(FolderAccess.read)
                    Text(L.text("settings.folder.readWrite")).tag(FolderAccess.readWrite)
                }
                .pickerStyle(.inline)
                Divider()
                Button(L.text("settings.folder.remove"), role: .destructive) { store.removeFolder(grant.id) }
            } label: {
                Text(L.text(grant.access == .read ? "settings.folder.read" : "settings.folder.readWrite"))
                    .foregroundStyle(Color.hmMuted)
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }

    @ViewBuilder
    private var messagesStatus: some View {
        if !store.messagesReadable {
            VStack(alignment: .leading, spacing: DesignTokens.Mac.statusBadgeGap) {
                small(L.text("settings.sees.needsFullDisk"), color: Color.hmMuted)
                small(L.text("settings.sees.fullDisk.step1"), color: Color.hmMuted)
                Text(Self.linked(L.text("settings.sees.fullDisk.step2")))
                    .hmType(DesignTokens.TypeScale.macSmall)
                    .foregroundStyle(Color.hmMuted)
                    .tint(Color.hmSun)
                    .fixedSize(horizontal: false, vertical: true)
                    .environment(\.openURL, OpenURLAction { url in
                        guard url.scheme == Self.revealScheme else { return .systemAction }
                        MacSettingsStore.revealApp()
                        return .handled
                    })
                small(L.text("settings.sees.fullDisk.step3"), color: Color.hmMuted)
                Button(L.text("settings.sees.openFullDisk")) { MacSettingsStore.openPrivacyPane("Privacy_AllFiles") }
                    .buttonStyle(MacButtonStyle(role: .primary, height: DesignTokens.Mac.smallButtonHeight, small: true))
            }
        } else if let problem = store.messagesProblem {
            small(Self.text(for: problem), color: Color.hmDanger)
        } else {
            small(L.text("settings.sees.messages.fromNow"), color: Color.hmMuted)
        }
    }

    private func small(_ text: String, color: Color) -> some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.macSmall)
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }

    static let revealScheme = "himawari-reveal"

    static func linked(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    static func text(for problem: MessagesProblem) -> String {
        switch problem {
        case .serverNotReady: L.text("settings.sees.messages.serverNotReady")
        case .cannotRead: L.text("settings.sees.messages.cannotRead")
        case let .unknownLayout(missing): L.format("settings.sees.messages.unknownLayout", missing.joined(separator: ", "))
        case .cannotSend: L.text("settings.sees.messages.cannotSend")
        }
    }

    private func permissionHint(_ key: String, button: String, anchor: String) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.Mac.statusBadgeGap) {
            Text(L.text(key))
                .hmType(DesignTokens.TypeScale.macSmall)
                .foregroundStyle(Color.hmDanger)
                .fixedSize(horizontal: false, vertical: true)
            Button(L.text(button)) { MacSettingsStore.openPrivacyPane(anchor) }
                .buttonStyle(.pressable)
                .hmType(DesignTokens.TypeScale.macSmall)
                .foregroundStyle(Color.hmSun)
        }
    }

    private func addFolders() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        store.addFolders(panel.urls)
    }

    private func addApps() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.applicationBundle]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        guard panel.runModal() == .OK else { return }
        store.addApps(panel.urls)
    }

    private func startRecording() {
        recording = true
        recordingProblem = false
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard let shortcut = GlobalShortcut.shortcut(from: event) else { return event }
            guard shortcut.hasModifier else {
                recordingProblem = true
                return nil
            }
            store.setShortcut(shortcut)
            stopRecording()
            return nil
        }
    }

    private func stopRecording() {
        recording = false
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }
}
#endif
