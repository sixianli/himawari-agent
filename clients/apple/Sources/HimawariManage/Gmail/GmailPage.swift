import AuthenticationServices
import HimawariDesign
import SwiftUI

struct GmailPage: View {
    let store: GmailStore
    let back: () -> Void
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var disconnecting = false
    @State private var problem: GmailConnectOutcome?

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.gmailTitle, leading: .back, action: back)
            if let overview = store.overview, overview.dailyLimitReached, store.status != .disconnected {
                note(M.gmailDailyLimit)
            }
            switch store.status {
            case .disconnected:
                SettingsGroup(label: nil) {
                    SettingsRow(icon: nil, title: M.gmailConnectTitle, detail: M.gmailConnectBody, last: true)
                }
                connectButton(M.gmailConnect)
            case .connected(let account, let since, let lastRead):
                SettingsGroup(label: nil) {
                    SettingsRow(icon: nil, title: account ?? M.gmailTitle, detail: since.map(M.gmailConnectedOn), last: lastRead == nil)
                    if let lastRead {
                        SettingsRow(icon: nil, title: M.gmailLastRead, value: M.relative(lastRead), last: true)
                    }
                }
                disconnectButton
            case .needsReconnect(let unreadSince):
                SettingsGroup(label: nil) {
                    SettingsRow(icon: nil, title: M.gmailExpired, warning: unreadSince.map(M.gmailUnreadSince), last: true)
                }
                connectButton(M.gmailReconnect)
                disconnectButton
            case nil:
                if store.phase == .loading {
                    ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                }
            }
        }
        .refreshable { await store.load() }
        .task { await store.load() }
        .confirmationDialog(M.gmailDisconnect, isPresented: $disconnecting, titleVisibility: .visible) {
            Button(M.gmailDisconnect, role: .destructive, action: disconnect)
        } message: {
            Text(M.gmailDisconnectDetail)
        }
        .alert(
            problem == .denied ? M.gmailDenied : M.gmailFailed,
            isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })
        ) {}
    }

    private func connectButton(_ title: String) -> some View {
        Button(action: connect) {
            HStack(spacing: SL.rowGap) {
                if store.connecting { ProgressView() }
                Text(title)
            }
            .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.pill)
        }
        .buttonStyle(.borderedProminent)
        .disabled(store.connecting)
    }

    private var disconnectButton: some View {
        Button(role: .destructive) { disconnecting = true } label: {
            Text(M.gmailDisconnect).frame(maxWidth: .infinity, minHeight: DesignTokens.Size.pill)
        }
        .buttonStyle(.bordered)
        .disabled(store.connecting)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(Color.hmMuted)
            .padding(.horizontal, SL.groupLabelPadding)
    }

    private func connect() {
        let session = webAuthenticationSession
        Task {
            let outcome = await store.connect { page, scheme in
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
                try await store.disconnect(reason: M.gmailDisconnect)
            } catch {
                problem = .failed
            }
        }
    }
}
