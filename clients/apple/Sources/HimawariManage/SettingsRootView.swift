import HimawariCore
import HimawariDesign
import SwiftUI

public struct SettingsRootView<Senses: View>: View {
    private let api: DeviceAPI
    private let close: () -> Void
    private let senses: Senses?
    @State private var sensesOpen = false

    public init(api: DeviceAPI, close: @escaping () -> Void, senses: () -> Senses?) {
        self.api = api
        self.close = close
        self.senses = senses()
    }

    public var body: some View {
        ZStack(alignment: .topLeading) {
            if senses == nil {
                EmptyStateView(Text(PlaceholderText.notConnected))
            } else {
                ScrollView {
                    GroupedSection {
                        Button { sensesOpen = true } label: {
                            GroupedRow(Text(PlaceholderText.senses)) {
                                Icon(.eye)
                            } trailing: {
                                EmptyView()
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, DesignTokens.Size.pagePaddingX)
                    .padding(.top, DesignTokens.Size.navBarHeight + DesignTokens.Size.sheetPaddingTop)
                }
            }
            GlassCircleButton(Text(PlaceholderText.close), action: close) {
                Icon(.x, size: DesignTokens.IconSize.glassButton)
            }
            .padding(DesignTokens.Size.sheetPaddingHorizontal)
        }
        .himawariScreenBackground()
        .sheet(isPresented: $sensesOpen) {
            senses
        }
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

    static var senses: String {
        switch String(Locale.preferredLanguages.first?.prefix(2) ?? "") {
        case "ja": "Himawari に感じ取らせる"
        case "en": "Let Himawari Sense"
        default: "让 Himawari 感知"
        }
    }
}
