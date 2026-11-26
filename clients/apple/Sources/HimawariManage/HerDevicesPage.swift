import HimawariCore
import HimawariDesign
import SwiftUI

struct HerDevicesPage: View {
    let store: SettingsStore
    let open: (PairedDevice) -> Void
    let removedThisDevice: () -> Void
    let back: () -> Void
    @State private var disconnecting = false
    @State private var failed = false

    private var thisPhone: PairedDevice? { store.devices.first(where: store.isThisDevice) }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.devicesTitle, leading: .back, action: back)
            if let phone = thisPhone {
                SettingsGroup(label: nil) {
                    Button { open(phone) } label: {
                        HerRow(
                            icon: .deviceMobilePlain,
                            title: M.thisIPhone,
                            subtitle: M.phoneLine(phone.name, M.presence(store.presence(phone))),
                            last: true
                        )
                    }
                    .buttonStyle(.pressable)
                }
            }
            if let origin = store.identity?.origin {
                SettingsGroup(label: M.server) {
                    SettingsRow(
                        icon: nil,
                        title: origin.host() ?? origin.absoluteString,
                        detail: thisPhone.flatMap { Timestamp.parse($0.pairedAt) }.map(M.pairedSince),
                        last: true
                    )
                }
            }
            if thisPhone != nil {
                Button { disconnecting = true } label: {
                    Text(M.disconnectThisIPhone)
                        .hmType(SL.rowValue)
                        .foregroundStyle(Color.hmDanger)
                        .padding(.horizontal, DesignTokens.Her.pillPaddingX)
                        .frame(minHeight: DesignTokens.Size.pill)
                        .background(Color.hmFill, in: Capsule())
                }
                .buttonStyle(.pressable)
                .frame(maxWidth: .infinity)
            }
        }
        .confirmationDialog(M.disconnectThisIPhone, isPresented: $disconnecting, titleVisibility: .visible) {
            Button(M.disconnectThisIPhone, role: .destructive, action: disconnect)
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func disconnect() {
        guard let phone = thisPhone else { return }
        Task {
            do {
                try await store.revoke(phone, reason: M.disconnectThisIPhone)
                removedThisDevice()
            } catch {
                failed = true
            }
        }
    }
}
