import HimawariCore
import HimawariDesign
import SwiftUI

public struct SettingsRootView: View {
    enum Page: Hashable {
        case capabilities
        case device(String)
        case addDevice
        case files
        case loginBrowsers
        case export
    }

    @State private var store: SettingsStore
    @State private var path: [Page] = []
    private let close: () -> Void
    private let removedThisDevice: () -> Void

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, close: @escaping () -> Void, removedThisDevice: @escaping () -> Void) {
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        let identity = api.http.currentCredentials.map {
            DeviceIdentity(deviceId: $0.deviceId, origin: $0.origin, access: $0.access)
        }
        _store = State(initialValue: SettingsStore(gateway: gateway, identity: identity))
        self.close = close
        self.removedThisDevice = removedThisDevice
    }

    init(store: SettingsStore, path: [Page] = [], close: @escaping () -> Void) {
        _store = State(initialValue: store)
        _path = State(initialValue: path)
        self.close = close
        removedThisDevice = {}
    }

    public var body: some View {
        NavigationStack(path: $path) {
            SettingsPage(gap: SL.rootGap) {
                SheetHeader(title: M.settings, leading: .close, action: close)
                IdentityCard(subtitle: M.serverLine(store.server))
                if store.phase == .loaded {
                    DevicesGroup(store: store, open: { path.append(.device($0.id)) }, add: { path.append(.addDevice) })
                    SettingsGroup(label: M.general) {
                        Button { path.append(.export) } label: {
                            SettingsRow(icon: .upload, title: M.exportTitle, chevron: true, last: true)
                        }
                        .buttonStyle(.plain)
                    }
                    SettingsGroup(label: M.himawariSelf) {
                        Button { path.append(.capabilities) } label: {
                            SettingsRow(icon: .bolt, title: M.capabilities, value: "\(store.capabilityCount)", chevron: true)
                        }
                        .buttonStyle(.plain)
                        Button { path.append(.files) } label: {
                            SettingsRow(icon: .fileText, title: M.files, chevron: true)
                        }
                        .buttonStyle(.plain)
                        Button { path.append(.loginBrowsers) } label: {
                            SettingsRow(
                                icon: .world,
                                title: M.loginBrowsers,
                                value: store.loginDevices.map { "\($0.count)" },
                                chevron: true,
                                last: store.server == nil
                            )
                        }
                        .buttonStyle(.plain)
                        if let server = store.server {
                            SettingsRow(
                                icon: .server,
                                title: M.server,
                                value: M.serverState(server),
                                tone: server == .connected ? .good : .muted,
                                last: true
                            )
                        }
                    }
                } else if store.phase == .failed {
                    EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                }
            }
            .refreshable { await store.load() }
            .navigationDestination(for: Page.self) { page in
                switch page {
                case .capabilities: CapabilitiesPage(store: store) { path.removeLast() }
                case .device(let id): DevicePage(store: store, deviceId: id, removedThisDevice: removedThisDevice) { path.removeLast() }
                case .addDevice: AddDevicePage(store: store) { path.removeLast() }
                case .files: StoredFilesPage(store: store) { path.removeLast() }
                case .loginBrowsers: LoginDevicesPage(store: store) { path.removeLast() }
                case .export: DataExportPage(session: store.export) { path.removeLast() }
                }
            }
        }
        .task { await store.load() }
    }
}

struct SettingsPage<Content: View>: View {
    let gap: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: gap) { content }
                .padding(.top, DesignTokens.Size.sheetPaddingTop)
                .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        }
        .scrollIndicators(.hidden)
        .himawariScreenBackground()
        .toolbar(.hidden, for: .navigationBar)
    }
}

struct IdentityCard: View {
    let subtitle: String

    var body: some View {
        HStack(spacing: SL.identityGap) {
            SunflowerMark().frame(width: SL.identityMark, height: SL.identityMark)
            VStack(alignment: .leading, spacing: SL.identityTextGap) {
                Text(verbatim: "Himawari").hmType(SL.identityName).foregroundStyle(Color.hmText)
                Text(subtitle).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, SL.identityPaddingVertical)
        .padding(.horizontal, SL.identityPaddingHorizontal)
        .himawariCard(padding: EdgeInsets())
    }
}
