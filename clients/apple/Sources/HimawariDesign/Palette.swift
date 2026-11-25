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
    case himawari
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

    public func with(face: TypeFace) -> TypeToken {
        TypeToken(size: size, weight: weight, lineHeight: lineHeight, face: face, tracking: tracking)
    }

    @MainActor
    public var font: Font {
        font(scale: 1)
    }

    @MainActor
    public func font(scale: CGFloat) -> Font {
        let scaled = size * scale
        switch face {
        case .system: return .system(size: scaled, weight: fontWeight)
        case .rounded: return .system(size: scaled, weight: fontWeight, design: .rounded)
        case .himawari: return .himawari(scaled, weight: voiceWeight, fixed: true)
        }
    }

    var voiceWeight: HimawariVoiceWeight {
        weight >= 550 ? .semibold : (weight >= 450 ? .medium : .regular)
    }
}

public enum TextScale {
    @MainActor
    public static func ratio(for size: DynamicTypeSize) -> CGFloat {
        #if os(iOS)
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
        return UIFontMetrics(forTextStyle: .body).scaledValue(for: 100, compatibleWith: traits) / 100
        #else
        return 1
        #endif
    }
}

struct ScaledType: ViewModifier {
    let token: TypeToken
    let design: Font.Design?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let ratio = TextScale.ratio(for: dynamicTypeSize)
        content
            .font(design.map { Font.system(size: token.size * ratio, weight: token.fontWeight, design: $0) } ?? token.font(scale: ratio))
            .tracking(token.tracking)
            .hmLineHeight(token.lineHeight.map { $0 * ratio })
    }
}

extension View {
    public func hmShadow(_ token: ShadowToken) -> some View {
        shadow(color: token.color.color, radius: token.blur / 2, x: token.x, y: token.y)
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
    public static var hmOnSpeak: Color { DesignTokens.Colors.onSpeak.color }
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
