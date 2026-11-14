import CoreText
import Observation
import SwiftUI

@MainActor
@Observable
public final class SerifFace {
    public static let shared = SerifFace()

    public static let regularName = "STSongti-SC-Regular"
    public static let boldName = "STSongti-SC-Bold"

    public private(set) var installed: Bool

    private init() {
        installed = Self.isInstalled(Self.regularName)
    }

    public func prepare() {
        guard !installed else { return }
        let names = [Self.regularName, Self.boldName]
        let descriptors = names.map { CTFontDescriptorCreateWithAttributes([kCTFontNameAttribute as String: $0] as CFDictionary) } as CFArray
        CTFontDescriptorMatchFontDescriptorsWithProgressHandler(descriptors, nil, Self.progressHandler())
    }

    nonisolated private static func progressHandler() -> CTFontDescriptorProgressHandler {
        { state, _ in
            if state == .didFinish {
                Task { @MainActor in
                    SerifFace.shared.installed = SerifFace.isInstalled(SerifFace.regularName)
                }
            }
            return true
        }
    }

    nonisolated static func isInstalled(_ name: String) -> Bool {
        let font = CTFontCreateWithName(name as CFString, 12, nil)
        return (CTFontCopyPostScriptName(font) as String) == name
    }
}

public enum HimawariVoiceWeight: Sendable {
    case regular
    case medium
    case semibold
}

extension Font {
    @MainActor
    public static func himawari(_ size: CGFloat, weight: HimawariVoiceWeight = .medium, relativeTo style: Font.TextStyle = .body) -> Font {
        guard SerifFace.shared.installed else {
            let mapped: Font.Weight = weight == .regular ? .regular : (weight == .medium ? .medium : .semibold)
            return .system(size: size, weight: mapped, design: .serif)
        }
        let name = weight == .semibold ? SerifFace.boldName : SerifFace.regularName
        return .custom(name, size: size, relativeTo: style)
    }

    public static func rounded(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .rounded)
    }
}
