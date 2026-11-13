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
        #if canImport(UIKit)
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

    @MainActor
    public var font: Font {
        switch face {
        case .system: .system(size: size, weight: fontWeight)
        case .rounded: .system(size: size, weight: fontWeight, design: .rounded)
        case .himawari: .himawari(size, weight: weight >= 550 ? .semibold : (weight >= 450 ? .medium : .regular))
        }
    }
}

extension View {
    public func hmShadow(_ token: ShadowToken) -> some View {
        shadow(color: token.color.color, radius: token.blur / 2, x: token.x, y: token.y)
    }

    @MainActor
    public func hmType(_ token: TypeToken) -> some View {
        font(token.font).tracking(token.tracking).hmLineHeight(token.lineHeight)
    }

    public func hmType(_ token: TypeToken, design: Font.Design) -> some View {
        font(.system(size: token.size, weight: token.fontWeight, design: design)).tracking(token.tracking).hmLineHeight(token.lineHeight)
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
    public static var hmScrim: Color { DesignTokens.Colors.scrim.color }
    public static var hmSwitchOff: Color { DesignTokens.Colors.switchOff.color }
    public static var hmGlass: Color { DesignTokens.Colors.glass.color }
    public static var hmGlassLine: Color { DesignTokens.Colors.glassLine.color }
}

extension Text {
    @MainActor
    public func hmText(_ token: TypeToken) -> Text {
        font(token.font).tracking(token.tracking)
    }
}
