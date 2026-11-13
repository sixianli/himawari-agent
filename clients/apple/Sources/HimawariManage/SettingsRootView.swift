import HimawariCore
import HimawariDesign
import SwiftUI

public struct SettingsRootView: View {
    private let api: DeviceAPI
    private let close: () -> Void

    public init(api: DeviceAPI, close: @escaping () -> Void) {
        self.api = api
        self.close = close
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            EmptyStateView(Text(PlaceholderText.notConnected))
            GlassCircleButton(Text(PlaceholderText.close), action: close) {
                Icon(.x, size: DesignTokens.IconSize.glassButton)
            }
            .padding(16)
        }
        .himawariScreenBackground()
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
