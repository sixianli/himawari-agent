import HimawariDesign
import SwiftUI

struct ConnectionsPage: View {
    let store: ConnectionsStore
    let open: (AppConnection) -> Void
    let back: () -> Void

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.connectionsTitle, leading: .back, action: back)
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
        .refreshable { await store.load() }
        .task { await store.load() }
    }

    private func icon(_ connection: AppConnection) -> IconName {
        connection.name == GmailStore.source ? .mail : .puzzle
    }

    private func summary(_ connection: AppConnection) -> String {
        switch connection.status {
        case "connected": connection.account ?? M.connectionConnected
        case "needs_reconnect": M.connectionExpired
        default: M.gmailNotConnected
        }
    }
}
