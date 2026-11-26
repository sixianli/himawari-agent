import HimawariCore
import HimawariDesign
import SwiftUI
#if canImport(HighlightSwift)
import HighlightSwift
#endif

enum CodeColors {
    static func css(dark: Bool) -> String {
        func value(_ token: PaletteToken) -> String {
            let c = dark ? token.dark : token.light
            return "rgba(\(Int((c.red * 255).rounded())),\(Int((c.green * 255).rounded())),\(Int((c.blue * 255).rounded())),\(c.alpha))"
        }
        let colors = DesignTokens.Colors.self
        let rules: [(String, PaletteToken)] = [
            (".hljs", colors.text),
            (".hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-built_in,.hljs-meta .hljs-keyword", colors.codeKeyword),
            (".hljs-string,.hljs-regexp,.hljs-char.escape_,.hljs-subst,.hljs-symbol", colors.codeString),
            (".hljs-comment,.hljs-quote,.hljs-meta", colors.codeComment),
            (".hljs-number,.hljs-variable.constant_", colors.codeNumber),
            (".hljs-type,.hljs-title,.hljs-title.class_,.hljs-title.function_,.hljs-attr,.hljs-attribute,.hljs-property,.hljs-section", colors.codeType),
        ]
        return rules.map { "\($0.0){color:\(value($0.1));}" }.joined()
    }
}

final class HighlightCache: @unchecked Sendable {
    private final class Box {
        let value: AttributedString?
        init(_ value: AttributedString?) { self.value = value }
    }

    private let cache = NSCache<NSString, Box>()

    init() {
        cache.countLimit = 300
    }

    func cached(_ key: String) -> AttributedString?? {
        cache.object(forKey: key as NSString).map(\.value)
    }

    func store(_ key: String, _ value: AttributedString?) {
        cache.setObject(Box(value), forKey: key as NSString)
    }
}

struct AnswerCodeBlock: View {
    let language: String?
    let code: String
    let copy: (String) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var highlighted: AttributedString?
    @State private var highlightedDark: Bool?
    @State private var copied = 0
    @State private var showingCheck = false

    private static let small = DesignTokens.TypeScale.secondary
    private static let label = DesignTokens.TypeScale.caption

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if let language {
                    Text(verbatim: language)
                        .hmType(Self.label)
                        .foregroundStyle(Color.hmMuted)
                }
                Spacer(minLength: 0)
                Button {
                    copy(code)
                    Haptics.shared.report(.copied)
                    copied += 1
                    showingCheck = true
                } label: {
                    Image(systemName: showingCheck ? "checkmark" : "doc.on.doc")
                        .font(.system(size: Self.label.size))
                        .foregroundStyle(Color.hmMuted)
                        .frame(minWidth: DesignTokens.Size.minTapTarget, minHeight: DesignTokens.Size.minTapTarget, alignment: .trailing)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .accessibilityLabel(Text(L.text("chat.copyCode")))
                .task(id: copied) {
                    guard copied > 0 else { return }
                    try? await Task.sleep(for: .seconds(1.5))
                    showingCheck = false
                }
            }
            .padding(.leading, DesignTokens.Chat.codePadding)
            .padding(.trailing, DesignTokens.Chat.codePadding - (DesignTokens.Size.minTapTarget - Self.label.size) / 2)
            .frame(height: DesignTokens.Size.minTapTarget)
            ScrollView(.horizontal) {
                Text(shownCode)
                    .hmType(Self.small, design: .monospaced)
                    .foregroundStyle(Color.hmText)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding([.horizontal, .bottom], DesignTokens.Chat.codePadding)
            }
            .scrollIndicators(.hidden)
        }
        .background(Color.hmBubbleCode, in: RoundedRectangle(cornerRadius: DesignTokens.Chat.codeRadius, style: .continuous))
        .task(id: HighlightKey(code: code, language: language, dark: colorScheme == .dark)) {
            let dark = colorScheme == .dark
            guard Self.done.cached(Self.key(code, language, dark)) == nil else { return }
            let result = await Self.highlight(code, language: language, dark: dark)
            Self.done.store(Self.key(code, language, dark), result)
            highlighted = result
            highlightedDark = dark
        }
    }

    private var shownCode: AttributedString {
        let dark = colorScheme == .dark
        if let cached = Self.done.cached(Self.key(code, language, dark)), let cached { return cached }
        if highlightedDark == dark, let highlighted { return highlighted }
        return AttributedString(code)
    }

    private static let done = HighlightCache()

    private static func key(_ code: String, _ language: String?, _ dark: Bool) -> String {
        "\(dark ? 1 : 0)|\(language ?? "")|\(code)"
    }

    private struct HighlightKey: Hashable {
        let code: String
        let language: String?
        let dark: Bool
    }

    static func highlight(_ code: String, language: String?, dark: Bool) async -> AttributedString? {
        #if canImport(HighlightSwift)
        guard let language = language?.split(separator: " ").first.map(String.init)?.lowercased(), !language.isEmpty else { return nil }
        do {
            let result = try await Highlight().request(code, mode: .languageAliasIgnoreIllegal(language), colors: .custom(css: CodeColors.css(dark: dark)))
            guard !result.isUndefined else { return nil }
            return result.attributedText
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }
}
