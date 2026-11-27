import HimawariDesign
import SwiftUI

struct AddAppConnectionPage: View {
    let store: ConnectionsStore
    let added: (AppConnection) -> Void
    let back: () -> Void
    @State private var app = NewAppConnection()
    @State private var failure: String?

    var body: some View {
        SettingsPage(gap: VL.formGap) {
            SheetHeader(title: M.connectionAdd, leading: .back, action: back)
            SettingsGroup(label: nil) {
                VaultFieldRow(label: M.connectionAddAddress) {
                    TextField("https://", text: $app.serverUrl)
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        #endif
                }
                VaultFieldRow(label: M.connectionAddName, note: M.connectionAddNameNote, last: true) {
                    TextField("", text: $app.title)
                }
            }
            VaultNote(M.connectionAddWarning)
            SettingsGroup(label: M.connectionAddAdvanced) {
                VaultFieldRow(label: M.connectionAddClientId) { TextField("", text: $app.clientId) }
                VaultSecretField(label: M.connectionAddClientSecret, value: $app.clientSecret, last: true)
            }
            VaultNote(M.connectionAddAdvancedNote)
            if let failure { VaultNote(failure, tone: .danger) }
            Spacer(minLength: VL.formGap)
            Button(action: add) {
                HStack(spacing: VL.buttonGap) {
                    if store.adding { ProgressView() }
                    Text(M.connectionAdd)
                }
            }
            .buttonStyle(CapsuleButtonStyle(.primary, height: VL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
            .disabled(!app.ready || store.adding)
        }
    }

    private func add() {
        failure = nil
        Task {
            switch await store.add(app, reason: M.connectionAddReason) {
            case .added(let connection):
                app.clientSecret = ""
                added(connection)
            case .invalidAddress:
                failure = M.connectionAddInvalid
            case .unreachable:
                failure = M.connectionAddUnreachable
            case .failed:
                failure = M.connectionAddFailed
            }
        }
    }
}
