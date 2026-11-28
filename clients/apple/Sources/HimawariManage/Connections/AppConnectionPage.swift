import AuthenticationServices
import HimawariDesign
import SwiftUI

struct AppConnectionPage: View {
    let store: ConnectionsStore
    let name: String
    let back: () -> Void
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var disconnecting = false
    @State private var removing = false
    @State private var problem: ConnectionOutcome?

    var body: some View {
        let connection = store.connection(named: name)
        let title = connection?.title ?? name
        SettingsPage {
            SheetHeader(title: title, leading: .back, action: back)
            switch connection?.status {
            case "connected":
                SettingsGroup(label: nil) {
                    SettingsRow(
                        icon: nil,
                        title: connection?.account ?? M.connectionConnected,
                        detail: connection?.connectedAt.flatMap(Timestamp.parse).map(M.gmailConnectedOn))
                }
                disconnectButton(title)
                removeButton(connection, title: title)
            case "needs_reconnect":
                SettingsGroup(label: nil) {
                    SettingsRow(icon: nil, title: M.connectionExpired)
                }
                connectButton(M.gmailReconnect, title: title)
                disconnectButton(title)
                removeButton(connection, title: title)
            case .some:
                SettingsGroup(label: nil) {
                    SettingsRow(
                        icon: nil,
                        title: M.connectionConnect(title),
                        detail: connection?.added == true ? M.connectionAddedAbout(title) : M.connectionAbout(title))
                }
                connectButton(M.connectionConnect(title), title: title)
                removeButton(connection, title: title)
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
        .confirmationDialog(M.connectionRemove(title), isPresented: $removing, titleVisibility: .visible) {
            Button(M.connectionRemove(title), role: .destructive, action: remove)
        } message: {
            Text(M.connectionRemoveDetail)
        }
        .alert(
            alertTitle(title),
            isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })
        ) {} message: {
            if case .clientRequired(let redirectUri) = problem {
                Text(M.connectionClientRequiredDetail(title, redirectUri))
            }
        }
    }

    private func alertTitle(_ title: String) -> String {
        switch problem {
        case .denied: M.connectionDenied(title)
        case .clientRequired: M.connectionClientRequired(title)
        default: M.connectionFailed(title)
        }
    }

    @ViewBuilder
    private func removeButton(_ connection: AppConnection?, title: String) -> some View {
        if connection?.added == true {
            DestructiveRow(title: M.connectionRemove(title)) { removing = true }
                .disabled(store.connecting != nil)
        }
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
        .outsideRowCard()
    }

    private func disconnectButton(_ title: String) -> some View {
        DestructiveRow(title: M.connectionDisconnect(title)) { disconnecting = true }
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
            switch outcome {
            case .denied, .failed, .clientRequired: problem = outcome
            case .connected, .cancelled: break
            }
        }
    }

    private func remove() {
        Task {
            do {
                try await store.remove(name)
                back()
            } catch {
                problem = .failed
            }
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
