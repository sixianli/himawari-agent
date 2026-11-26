import HimawariDesign
import SwiftUI

struct ConnectionsPage: View {
    let store: ConnectionsStore
    var actions: DeviceActionsModel? = nil
    var openSenses: (() -> Void)? = nil
    let open: (AppConnection) -> Void
    let back: () -> Void
    @State private var primer: PermissionState?

    static let onThisDevice = ["calendar", "reminders", "contacts"]

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.connectionsTitle, leading: .back, action: back)
            if !store.shown.isEmpty {
                SettingsGroup(label: nil) {
                    ForEach(store.shown) { connection in
                        Button { open(connection) } label: {
                            HerRow(
                                icon: icon(connection),
                                title: connection.title,
                                subtitle: summary(connection),
                                last: connection.id == store.shown.last?.id
                            )
                        }
                        .buttonStyle(.pressable)
                    }
                }
            }
            if !local.isEmpty || openSenses != nil {
                SettingsGroup(label: M.connectionsThisDevice) {
                    ForEach(local) { permission in
                        Button { primer = permission } label: {
                            HerRow(
                                icon: icon(permission),
                                title: permission.name,
                                subtitle: L.text("permission.status.\(permission.status.rawValue)"),
                                last: openSenses == nil && permission.id == local.last?.id
                            )
                        }
                        .buttonStyle(.pressable)
                    }
                    if let openSenses {
                        Button(action: openSenses) {
                            HerRow(icon: .heartbeat, title: M.connectionHealth, subtitle: M.connectionHealthInSenses, last: true)
                        }
                        .buttonStyle(.pressable)
                    }
                }
            }
        }
        .refreshable { await reload() }
        .task { await reload() }
        .sheet(item: $primer) { permission in
            PermissionPrimerView(permission: local.first { $0.id == permission.id } ?? permission) {
                Task { await actions?.request(permission.id) }
            } close: {
                primer = nil
            }
            .presentationDetents([.medium, .large])
        }
    }

    private var local: [PermissionState] {
        let permissions = actions?.permissions ?? []
        return Self.onThisDevice.compactMap { id in permissions.first { $0.id == id } }
    }

    private func reload() async {
        async let listed: Void = store.load()
        await actions?.refreshPermissions()
        await listed
    }

    private func icon(_ connection: AppConnection) -> IconName {
        connection.name == GmailStore.source ? .mail : .puzzle
    }

    private func icon(_ permission: PermissionState) -> IconName {
        switch permission.id {
        case "calendar": .calendar
        case "reminders": .listCheck
        default: .addressBook
        }
    }

    private func summary(_ connection: AppConnection) -> String {
        switch connection.status {
        case "connected": connection.account ?? M.connectionConnected
        case "needs_reconnect": M.connectionExpired
        default: M.gmailNotConnected
        }
    }
}
