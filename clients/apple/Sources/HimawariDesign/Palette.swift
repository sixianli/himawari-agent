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

    public init(hex: UInt32, alpha: Double = 1) {
        red = Double((hex >> 16) & 0xFF) / 255
        green = Double((hex >> 8) & 0xFF) / 255
        blue = Double(hex & 0xFF) / 255
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

public enum Palette {
    public static let background = PaletteToken(light: RGBA(hex: 0xFCFCFB), dark: RGBA(hex: 0x1E1E1E))
    public static let surface = PaletteToken(light: RGBA(hex: 0xFFFFFF), dark: RGBA(hex: 0x2A2A2A))
    public static let text = PaletteToken(light: RGBA(hex: 0x252921), dark: RGBA(hex: 0xE4E4E1))
    public static let muted = PaletteToken(light: RGBA(hex: 0x6B7164), dark: RGBA(hex: 0xA0A09A))
    public static let fill = PaletteToken(light: RGBA(hex: 0x252921, alpha: 0.06), dark: RGBA(hex: 0xE4E4E1, alpha: 0.08))
    public static let fillStrong = PaletteToken(light: RGBA(hex: 0x252921, alpha: 0.11), dark: RGBA(hex: 0xE4E4E1, alpha: 0.15))
    public static let sun = PaletteToken(light: RGBA(hex: 0x9A6200), dark: RGBA(hex: 0xF2BB4F))
    public static let sunBright = PaletteToken(light: RGBA(hex: 0xC9870A), dark: RGBA(hex: 0xEFB23C))
    public static let danger = PaletteToken(light: RGBA(hex: 0xA73C30), dark: RGBA(hex: 0xEFA095))
    public static let success = PaletteToken(light: RGBA(hex: 0x42682A), dark: RGBA(hex: 0xACCD88))
    public static let separator = PaletteToken(light: RGBA(hex: 0x252921, alpha: 0.09), dark: RGBA(hex: 0xE4E4E1, alpha: 0.1))
    public static let glow = PaletteToken(light: RGBA(hex: 0xE8B04A, alpha: 0.34), dark: RGBA(hex: 0xEFB23C, alpha: 0.18))
    public static let onText = PaletteToken(light: RGBA(hex: 0xFCFCFB), dark: RGBA(hex: 0x1E1E1E))
    public static let speak = PaletteToken(light: RGBA(hex: 0x252921), dark: RGBA(hex: 0x0C0C0C))
    public static let badge = PaletteToken(light: RGBA(hex: 0xC0392B), dark: RGBA(hex: 0xC0392B))
    public static let tileFill = PaletteToken(light: RGBA(hex: 0xF8EBCB), dark: RGBA(hex: 0x4B3F25))
    public static let tileSymbol = PaletteToken(light: RGBA(hex: 0x8A5A00), dark: RGBA(hex: 0xF2BB4F))
    public static let lift = PaletteToken(light: RGBA(hex: 0x000000, alpha: 0.07), dark: RGBA(hex: 0x000000, alpha: 0.35))
    public static let liftBig = PaletteToken(light: RGBA(hex: 0x000000, alpha: 0.13), dark: RGBA(hex: 0x000000, alpha: 0.5))
}

extension Color {
    public static var hmBackground: Color { Palette.background.color }
    public static var hmSurface: Color { Palette.surface.color }
    public static var hmText: Color { Palette.text.color }
    public static var hmMuted: Color { Palette.muted.color }
    public static var hmFill: Color { Palette.fill.color }
    public static var hmFillStrong: Color { Palette.fillStrong.color }
    public static var hmSun: Color { Palette.sun.color }
    public static var hmSunBright: Color { Palette.sunBright.color }
    public static var hmDanger: Color { Palette.danger.color }
    public static var hmSuccess: Color { Palette.success.color }
    public static var hmSeparator: Color { Palette.separator.color }
    public static var hmGlow: Color { Palette.glow.color }
    public static var hmOnText: Color { Palette.onText.color }
    public static var hmSpeak: Color { Palette.speak.color }
    public static var hmBadge: Color { Palette.badge.color }
}
