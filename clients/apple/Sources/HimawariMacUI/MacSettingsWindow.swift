#if os(macOS)
import HimawariDesign
import HimawariManage
import HimawariShell
import ServiceManagement
import SwiftUI

struct MacSettingsWindow: View {
    let menu: MenuBarModel
    let main: MacMainModel

    var body: some View {
        TabView {
            Tab(L.text("settings.tab.general"), systemImage: "gearshape") {
                MacGeneralSettings()
            }
            if let workspace = main.workspace {
                ForEach(main.settingsSections, id: \.self) { section in
                    Tab(section.title, systemImage: MacSettingsWindow.symbol(section)) {
                        HerSectionPane(model: main.app, section: section, workspace: workspace, talk: { main.talk($0) }, openChat: {})
                            .frame(minHeight: DesignTokens.Mac.settingsHeight)
                    }
                }
            }
            Tab(L.text("settings.tab.mac"), systemImage: "laptopcomputer") {
                MacSettingsView(store: menu.settings, shortcutState: menu.shortcutState)
            }
        }
        .frame(width: DesignTokens.Mac.settingsWindowWidth)
    }

    static func symbol(_ section: HerSection) -> String {
        switch section {
        case .notifications: "bell"
        case .privacy: "hand.raised"
        default: "gearshape"
        }
    }
}

struct MacGeneralSettings: View {
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var failed = false

    var body: some View {
        Form {
            Section {
                Toggle(L.text("settings.launchAtLogin"), isOn: Binding(get: { launchAtLogin }, set: setLaunchAtLogin))
                if SMAppService.mainApp.status == .requiresApproval {
                    Text(L.text("settings.launchAtLogin.needsApproval"))
                        .foregroundStyle(.secondary)
                    Button(L.text("settings.launchAtLogin.openLoginItems")) {
                        SMAppService.openSystemSettingsLoginItems()
                    }
                }
            } footer: {
                Text(L.text("settings.launchAtLogin.detail"))
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { launchAtLogin = SMAppService.mainApp.status == .enabled }
        .alert(L.text("settings.launchAtLogin.failed"), isPresented: $failed) {}
    }

    private func setLaunchAtLogin(_ on: Bool) {
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            failed = true
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }
}
#endif
