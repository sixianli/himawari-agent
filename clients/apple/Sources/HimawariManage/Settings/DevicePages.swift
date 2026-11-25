import HimawariDesign
import SwiftUI

typealias DL = ManageLayout.DeviceSheet

struct DevicePage: View {
    let store: SettingsStore
    let deviceId: String
    var actions: DeviceActionsModel? = nil
    let removedThisDevice: () -> Void
    let back: () -> Void
    @State private var renaming = false
    @State private var draftName = ""
    @State private var failed = false

    private var device: PairedDevice? { store.devices.first { $0.id == deviceId } }

    var body: some View {
        SettingsPage(gap: DL.detailGap) {
            if let device {
                SheetHeader(title: device.name, leading: .back, action: back)
                SettingsGroup(label: nil) {
                    Button {
                        draftName = device.name
                        renaming = true
                    } label: {
                        SettingsRow(icon: nil, title: M.deviceName, value: device.name, chevron: true)
                    }
                    .buttonStyle(.plain)
                    presenceRow(device)
                    let channel = M.channel(device.releaseChannel)
                    SettingsRow(icon: nil, title: M.pairedOn, value: Timestamp.parse(device.pairedAt).map(M.pairedDay), last: channel == nil)
                    if let channel {
                        SettingsRow(icon: nil, title: M.deviceVersion, value: channel, last: true)
                    }
                }
                if let actions, store.isThisDevice(device) {
                    DeviceAbilitiesSection(model: actions)
                }
                Button {
                    Task {
                        do {
                            let wasThisDevice = store.isThisDevice(device)
                            try await store.revoke(device, reason: M.confirmRemove(device.name))
                            if wasThisDevice { removedThisDevice() } else { back() }
                        } catch {
                            failed = true
                        }
                    }
                } label: {
                    Text(M.removeDevice).hmType(SL.rowValue).foregroundStyle(Color.hmDanger)
                        .frame(minHeight: DL.linkMinHeight)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, DL.addLinkPadding)
            } else {
                SheetHeader(title: "", leading: .back, action: back)
            }
        }
        .alert(M.renameTitle, isPresented: $renaming) {
            TextField(M.deviceName, text: $draftName)
            Button(M.cancel, role: .cancel) {}
            Button(M.ok) { rename() }
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func presenceRow(_ device: PairedDevice) -> some View {
        let presence = store.presence(device)
        return VStack(spacing: 0) {
            HStack {
                Text(presence == .connected ? M.deviceNow : M.lastConnected).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(M.presence(presence)).hmType(SL.rowValue)
                    .foregroundStyle(presence == .connected ? Color.hmSuccess : Color.hmMuted)
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            RowSeparator()
        }
    }

    private func rename() {
        guard let device else { return }
        guard let name = DeviceName.accepted(draftName) else {
            failed = true
            return
        }
        guard name != device.name else { return }
        Task {
            do {
                try await store.rename(device, to: name, reason: M.confirmRename(name))
            } catch {
                failed = true
            }
        }
    }
}
