import HimawariCore
import HimawariDesign
import SwiftUI

public struct SettingsRootView: View {
    private enum Page {
        case approvals
        case thisDevice
    }

    private let actions: DeviceActionsModel
    private let device: ThisDevice
    private let openThread: ((String) -> Void)?
    private let close: () -> Void
    @State private var page: Page?

    public init(actions: DeviceActionsModel, device: ThisDevice, openThread: ((String) -> Void)? = nil, close: @escaping () -> Void) {
        self.actions = actions
        self.device = device
        self.openThread = openThread
        self.close = close
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            switch page {
            case .approvals:
                ApprovalsView(model: actions, openThread: openThread) { show(nil) }
                    .transition(.move(edge: .trailing))
            case .thisDevice:
                ThisDeviceView(device: device, model: actions) { show(nil) }
                    .transition(.move(edge: .trailing))
            case nil:
                home
            }
        }
        .himawariScreenBackground()
        .task { await actions.refresh() }
    }

    private var home: some View {
        ZStack(alignment: .topLeading) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    GroupedSection {
                        Button { show(.approvals) } label: {
                            GroupedRow(Text(L.text("approval.title")), icon: { Icon(.handStop, size: DesignTokens.IconSize.listRow) }) {
                                if actions.waitingCount > 0 { Text(actions.waitingCount, format: .number) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    GroupedSection {
                        Button { show(.thisDevice) } label: {
                            GroupedRow(Text(ThisDevice.title), icon: { Icon(.deviceMobile, size: DesignTokens.IconSize.listRow) }) {
                                Text(L.text("device.link.\(device.link.rawValue)"))
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, DesignTokens.Size.navBarHeight + 16)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            GlassCircleButton(Text(PlaceholderText.close), action: close) {
                Icon(.x, size: DesignTokens.IconSize.glassButton)
            }
            .padding(16)
        }
    }

    private func show(_ next: Page?) {
        withAnimation(.snappy) { page = next }
    }
}

enum PlaceholderText {
    static var notConnected: String {
        switch String(Locale.preferredLanguages.first?.prefix(2) ?? "") {
        case "ja": "このページはまだつながっていません"
        case "en": "This page isn't connected yet"
        default: "这一页还没接上"
        }
    }

    static var close: String {
        switch String(Locale.preferredLanguages.first?.prefix(2) ?? "") {
        case "ja": "閉じる"
        case "en": "Close"
        default: "关闭"
        }
    }
}
