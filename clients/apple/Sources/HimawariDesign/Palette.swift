import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct RGBA: Sendable, Equatable {
    public let red: Double
    public let green: Double
    public let blue: Double
    public let alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }
}

public struct PaletteToken: Sendable, Equatable {
    public let light: RGBA
    public let dark: RGBA

    public var color: Color {
        #if os(watchOS)
        Color(.sRGB, red: dark.red, green: dark.green, blue: dark.blue, opacity: dark.alpha)
        #elseif canImport(UIKit)
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: value.red, green: value.green, blue: value.blue, alpha: value.alpha)
        })
        #elseif canImport(AppKit)
        Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: value.red, green: value.green, blue: value.blue, alpha: value.alpha)
        })
        #endif
    }
}

public struct ShadowToken: Sendable {
    public let x: CGFloat
    public let y: CGFloat
    public let blur: CGFloat
    public let color: PaletteToken
}

public enum TypeFace: Sendable {
    case system
    case rounded
}

public struct TypeToken: Sendable {
    public let size: CGFloat
    public let weight: CGFloat
    public let lineHeight: CGFloat?
    public let face: TypeFace
    public let tracking: CGFloat

    public var fontWeight: Font.Weight {
        switch weight {
        case ..<350: .light
        case ..<450: .regular
        case ..<550: .medium
        case ..<650: .semibold
        case ..<750: .bold
        default: .heavy
        }
    }

    public init(size: CGFloat, weight: CGFloat, lineHeight: CGFloat?, face: TypeFace, tracking: CGFloat) {
        self.size = size
        self.weight = weight
        self.lineHeight = lineHeight
        self.face = face
        self.tracking = tracking
    }

    public var textStyle: Font.TextStyle? {
        #if os(iOS)
        switch size {
        case 34: .largeTitle
        case 28: .title
        case 22: .title2
        case 20: .title3
        case 17: .body
        case 16: .callout
        case 15: .subheadline
        case 13: .footnote
        case 12: .caption
        case 11: .caption2
        default: nil
        }
        #else
        nil
        #endif
    }

    var design: Font.Design {
        face == .rounded ? .rounded : .default
    }

    public var font: Font {
        font(scale: 1)
    }

    public func font(scale: CGFloat, design override: Font.Design? = nil) -> Font {
        if let textStyle {
            return .system(textStyle, design: override ?? design, weight: fontWeight)
        }
        return .system(size: size * scale, weight: fontWeight, design: override ?? design)
    }
}

public enum TextScale {
    @MainActor
    public static func ratio(for size: DynamicTypeSize, style: Font.TextStyle? = nil) -> CGFloat {
        #if os(iOS)
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
        return UIFontMetrics(forTextStyle: uiStyle(style ?? .body)).scaledValue(for: 100, compatibleWith: traits) / 100
        #else
        return 1
        #endif
    }

    #if os(iOS)
    static func uiStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .callout: .callout
        case .subheadline: .subheadline
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }
    #endif
}

struct ScaledType: ViewModifier {
    let token: TypeToken
    let design: Font.Design?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let ratio = TextScale.ratio(for: dynamicTypeSize, style: token.textStyle)
        content
            .font(token.font(scale: ratio, design: design))
            .tracking(token.tracking)
            .hmLineHeight(token.lineHeight.map { $0 * ratio })
    }
}

extension View {
    public func hmRaised<S: Shape, F: ShapeStyle>(_ shape: S, fill: F, shadow token: ShadowToken) -> some View {
        background {
            shape.fill(fill).shadow(color: token.color.color, radius: token.blur / 2, x: token.x, y: token.y)
        }
    }

    @MainActor
    public func hmType(_ token: TypeToken) -> some View {
        modifier(ScaledType(token: token, design: nil))
    }

    public func hmType(_ token: TypeToken, design: Font.Design) -> some View {
        modifier(ScaledType(token: token, design: design))
    }

    @ViewBuilder
    public func hmLineHeight(_ points: CGFloat?) -> some View {
        if let points {
            lineHeight(.exact(points: points))
        } else {
            self
        }
    }
}

extension Color {
    public static var hmBackground: Color { DesignTokens.Colors.bg.color }
    public static var hmSurface: Color { DesignTokens.Colors.surface.color }
    public static var hmText: Color { DesignTokens.Colors.text.color }
    public static var hmMuted: Color { DesignTokens.Colors.muted.color }
    public static var hmFill: Color { DesignTokens.Colors.fill.color }
    public static var hmFillStrong: Color { DesignTokens.Colors.fill2.color }
    public static var hmSun: Color { DesignTokens.Colors.sun.color }
    public static var hmSunBright: Color { DesignTokens.Colors.sunBright.color }
    public static var hmDanger: Color { DesignTokens.Colors.danger.color }
    public static var hmSuccess: Color { DesignTokens.Colors.success.color }
    public static var hmSeparator: Color { DesignTokens.Colors.separator.color }
    public static var hmGlow: Color { DesignTokens.Colors.glow.color }
    public static var hmOnText: Color { DesignTokens.Colors.onText.color }
    public static var hmSpeak: Color { DesignTokens.Colors.speak.color }
    public static var hmTile: Color { DesignTokens.Colors.iconTile.color }
    public static var hmGlyph: Color { DesignTokens.Colors.glyph.color }
    public static var hmScrim: Color { DesignTokens.Colors.scrim.color }
    public static var hmSwitchOff: Color { DesignTokens.Colors.switchOff.color }
    public static var hmGlass: Color { DesignTokens.Colors.glass.color }
    public static var hmGlassLine: Color { DesignTokens.Colors.glassLine.color }
    public static var hmLink: Color { DesignTokens.Colors.link.color }
    public static var hmReplyBar: Color { DesignTokens.Colors.replyBar.color }
}

extension Text {
    @MainActor
    public func hmText(_ token: TypeToken) -> Text {
        font(token.font).tracking(token.tracking)
    }
}
