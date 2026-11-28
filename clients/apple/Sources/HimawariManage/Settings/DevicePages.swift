import HimawariCore
import HimawariDesign
import SwiftUI

struct DevicePage: View {
    let store: SettingsStore
    let deviceId: String
    var actions: DeviceActionsModel? = nil
    let unsentMessages: () -> Int?
    let removedThisDevice: () -> Void
    let back: () -> Void
    @State private var renaming = false
    @State private var draftName = ""
    @State private var removing: PairedDevice?
    @State private var signingOut = false
    @State private var failure: String?

    private var device: PairedDevice? { store.devices.first { $0.id == deviceId } }

    var body: some View {
        List {
            if let device {
                Section {
                    Button {
                        draftName = device.name
                        renaming = true
                    } label: {
                        LabeledContent(M.deviceName, value: device.name)
                    }
                    .foregroundStyle(Color.hmText)
                    presenceRow(store.presence(device))
                    if let signedIn = Timestamp.parse(device.pairedAt) {
                        LabeledContent(M.signedInOn, value: M.pairedDay(signedIn))
                    }
                    if let channel = M.channel(device.releaseChannel) {
                        LabeledContent(M.deviceVersion, value: channel)
                    }
                }
                if let actions, store.isThisDevice(device) {
                    DeviceAbilitiesSection(model: actions)
                }
                Section {
                    if store.isThisDevice(device) {
                        Button(M.signOut, role: .destructive) { signingOut = true }
                            .frame(maxWidth: .infinity)
                    } else {
                        Button(M.removeDevice, role: .destructive) { removing = device }
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .deviceListStyle()
        .navigationTitle(device?.name ?? "")
        .alert(M.renameTitle, isPresented: $renaming) {
            TextField(M.deviceName, text: $draftName)
            Button(M.cancel, role: .cancel) {}
            Button(M.ok) { rename() }
        }
        .removeDeviceDialog(store: store, removing: $removing, failure: $failure, removed: back)
        .signOutDialog(store: store, signingOut: $signingOut, failure: $failure, unsentMessages: unsentMessages, signedOut: removedThisDevice)
        .alert(failure ?? "", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button(M.ok) {}
        }
    }

    private func presenceRow(_ presence: DevicePresence) -> some View {
        let connected = presence == .connected
        let title: String = connected ? M.deviceNow : M.lastConnected
        let tint: Color = connected ? Color.hmSun : Color.hmMuted
        return LabeledContent(title) {
            Text(M.presence(presence)).foregroundStyle(tint)
        }
    }

    private func rename() {
        guard let device else { return }
        guard let name = DeviceName.accepted(draftName) else {
            failure = M.actionFailed
            return
        }
        guard name != device.name else { return }
        Task {
            do {
                try await store.rename(device, to: name)
            } catch {
                failure = M.actionFailed
            }
        }
    }
}
