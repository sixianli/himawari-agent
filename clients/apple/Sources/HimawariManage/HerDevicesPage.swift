import HimawariCore
import HimawariDesign
import SwiftUI

struct HerDevicesPage: View {
    let store: SettingsStore
    let unsentMessages: () -> Int?
    let removedThisDevice: () -> Void
    var highlighted: String?
    @State private var flashing: String?
    @State private var removing: PairedDevice?
    @State private var signingOut = false
    @State private var failure: String?

    var body: some View {
        List {
            if let device = store.thisDevice {
                Section(M.thisDevice(device.kind)) {
                    NavigationLink(value: HerPage.Page.device(device.id)) {
                        DeviceRow(device: device, subtitle: M.inUse(signedIn: Timestamp.parse(device.pairedAt)), subtitleColor: Color.hmMuted)
                    }
                }
            }
            if !store.otherDevices.isEmpty {
                Section(M.otherDevices) {
                    ForEach(store.otherDevices) { device in
                        NavigationLink(value: HerPage.Page.device(device.id)) {
                            DeviceRow(device: device, subtitle: M.presence(store.presence(device)), subtitleColor: Color.hmMuted, online: store.presence(device) == .connected)
                        }
                        .listRowBackground(flashing == device.id ? Color.hmFill : nil)
                        .swipeActions {
                            Button(M.remove, role: .destructive) { removing = device }
                        }
                    }
                }
            }
            if let server = store.server {
                Section(M.server) {
                    VStack(alignment: .leading) {
                        Text(URL(string: server.origin)?.host() ?? server.origin)
                            .foregroundStyle(Color.hmText)
                            .textSelection(.enabled)
                        if let since = server.since.flatMap(Timestamp.parse) {
                            Text(M.serverSince(since)).font(.footnote).foregroundStyle(Color.hmMuted)
                        }
                    }
                }
            }
            if store.thisDevice != nil {
                Section {
                    Button(M.signOut, role: .destructive) { signingOut = true }
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .deviceListStyle()
        .navigationTitle(M.devicesTitle)
        .refreshable { await store.reloadDevices() }
        .task {
            if store.phase != .loaded { await store.load() }
            await flash(highlighted)
        }
        .removeDeviceDialog(store: store, removing: $removing, failure: $failure)
        .signOutDialog(store: store, signingOut: $signingOut, failure: $failure, unsentMessages: unsentMessages, signedOut: removedThisDevice)
        .alert(failure ?? "", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button(M.ok) {}
        }
    }
}

extension HerDevicesPage {
    @MainActor
    func flash(_ deviceId: String?) async {
        guard let deviceId, store.otherDevices.contains(where: { $0.id == deviceId }) else { return }
        flashing = deviceId
        try? await Task.sleep(for: .seconds(2))
        withAnimation(.easeOut) { flashing = nil }
    }
}

struct DeviceRow: View {
    let device: PairedDevice
    let subtitle: String
    let subtitleColor: Color
    var online = false

    var body: some View {
        Label {
            VStack(alignment: .leading) {
                Text(device.name).foregroundStyle(Color.hmText)
                HStack(spacing: DesignTokens.Size.rowGap / 2) {
                    if online {
                        Icon(.point, size: DesignTokens.IconSize.chevron / 2)
                            .foregroundStyle(Color.hmSun)
                    }
                    Text(subtitle).foregroundStyle(subtitleColor)
                }
                .font(.footnote)
            }
        } icon: {
            DeviceKindIcon(kind: device.kind)
        }
    }
}

struct DeviceKindIcon: View {
    let kind: String

    var body: some View {
        Group {
            switch kind {
            case "iphone": Icon(.deviceMobilePlain, size: DesignTokens.IconSize.listRow)
            case "mac": Icon(.deviceLaptop, size: DesignTokens.IconSize.listRow)
            case "watch": Icon(.deviceWatch, size: DesignTokens.IconSize.listRow)
            default: Icon(.infoCircle, size: DesignTokens.IconSize.listRow)
            }
        }
        .foregroundStyle(Color.hmSun)
        .accessibilityHidden(true)
    }
}

extension View {
    @ViewBuilder
    func deviceListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }

    func removeDeviceDialog(store: SettingsStore, removing: Binding<PairedDevice?>, failure: Binding<String?>, removed: @escaping () -> Void = {}) -> some View {
        confirmationDialog(
            removing.wrappedValue.map { M.removeQuestion($0.name) } ?? "",
            isPresented: Binding(get: { removing.wrappedValue != nil }, set: { if !$0 { removing.wrappedValue = nil } }),
            titleVisibility: .visible,
            presenting: removing.wrappedValue
        ) { device in
            Button(M.remove, role: .destructive) {
                Task {
                    do {
                        try await store.revoke(device, reason: M.confirmRemove(device.name))
                        removed()
                    } catch {
                        failure.wrappedValue = M.removeFailed
                    }
                }
            }
        } message: { _ in
            Text(M.removeExplain)
        }
    }

    func signOutDialog(store: SettingsStore, signingOut: Binding<Bool>, failure: Binding<String?>, unsentMessages: @escaping () -> Int?, signedOut: @escaping () -> Void) -> some View {
        confirmationDialog(M.signOutQuestion, isPresented: signingOut, titleVisibility: .visible) {
            Button(M.signOut, role: .destructive) {
                guard let device = store.thisDevice else { return }
                Task {
                    do {
                        try await store.revoke(device, reason: M.signOut)
                        signedOut()
                    } catch {
                        failure.wrappedValue = M.signOutFailed
                    }
                }
            }
        } message: {
            Text(M.signOutExplain(store.thisDevice?.kind ?? "iphone", unsent: unsentMessages()))
        }
    }
}
