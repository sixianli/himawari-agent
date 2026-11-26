import AuthenticationServices
import HimawariDesign
import SwiftUI

struct AppConnectionPage: View {
    let store: ConnectionsStore
    let name: String
    let back: () -> Void
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var disconnecting = false
    @State private var problem: ConnectionOutcome?

    var body: some View {
        let connection = store.connection(named: name)
        let title = connection?.title ?? name
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: title, leading: .back, action: back)
            switch connection?.status {
            case "connected":
                SettingsGroup(label: nil) {
                    SettingsRow(
                        icon: nil,
                        title: connection?.account ?? M.connectionConnected,
                        detail: connection?.connectedAt.flatMap(Timestamp.parse).map(M.gmailConnectedOn),
                        last: true
                    )
                }
                disconnectButton(title)
            case "needs_reconnect":
                SettingsGroup(label: nil) {
                    SettingsRow(icon: nil, title: M.connectionExpired, last: true)
                }
                connectButton(M.gmailReconnect, title: title)
                disconnectButton(title)
            case .some:
                SettingsGroup(label: nil) {
                    SettingsRow(icon: nil, title: M.connectionConnect(title), detail: M.connectionAbout(title), last: true)
                }
                connectButton(M.connectionConnect(title), title: title)
            case nil:
                if store.phase == .loading {
                    ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                }
            }
        }
        .refreshable { await store.load() }
        .confirmationDialog(M.connectionDisconnect(title), isPresented: $disconnecting, titleVisibility: .visible) {
            Button(M.connectionDisconnect(title), role: .destructive, action: disconnect)
        } message: {
            Text(M.connectionDisconnectDetail)
        }
        .alert(
            problem == .denied ? M.connectionDenied(title) : M.connectionFailed(title),
            isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })
        ) {}
    }

    private func connectButton(_ label: String, title: String) -> some View {
        Button(action: connect) {
            HStack(spacing: SL.rowGap) {
                if store.connecting == name { ProgressView() }
                Text(label)
            }
            .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.pill)
        }
        .buttonStyle(.borderedProminent)
        .disabled(store.connecting != nil)
    }

    private func disconnectButton(_ title: String) -> some View {
        Button(role: .destructive) { disconnecting = true } label: {
            Text(M.connectionDisconnect(title)).frame(maxWidth: .infinity, minHeight: DesignTokens.Size.pill)
        }
        .buttonStyle(.bordered)
        .disabled(store.connecting != nil)
    }

    private func connect() {
        let session = webAuthenticationSession
        Task {
            let outcome = await store.connect(name) { page, scheme in
                do {
                    return try await session.authenticate(using: page, callback: .customScheme(scheme), additionalHeaderFields: [:])
                } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                    return nil
                }
            }
            if outcome == .denied || outcome == .failed { problem = outcome }
        }
    }

    private func disconnect() {
        Task {
            do {
                try await store.disconnect(name)
            } catch {
                problem = .failed
            }
        }
    }
}
