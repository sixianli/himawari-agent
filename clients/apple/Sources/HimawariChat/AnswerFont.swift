import CoreText
import Foundation
import HimawariDesign
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

enum AnswerFont {
    static let chineseRegular = "NotoSerifSC-Regular"
    static let chineseSemibold = "NotoSerifSC-SemiBold"

    static let registered: Bool = {
        let urls = [chineseRegular, chineseSemibold].compactMap {
            Bundle.module.url(forResource: $0, withExtension: "otf", subdirectory: "Fonts") ?? Bundle.module.url(forResource: $0, withExtension: "otf")
        }
        return urls.count == 2 && urls.allSatisfy { CTFontManagerRegisterFontsForURL($0 as CFURL, .process, nil) }
    }()

    @MainActor private static var made: [String: CTFont] = [:]

    @MainActor
    static func make(size: CGFloat, semibold: Bool) -> CTFont {
        let key = "\(size)-\(semibold)"
        if let font = made[key] { return font }
        let font = build(size: size, semibold: semibold)
        made[key] = font
        return font
    }

    private static func build(size: CGFloat, semibold: Bool) -> CTFont {
        _ = registered
        let chinese = semibold ? chineseSemibold : chineseRegular
        #if canImport(UIKit)
        let system = UIFont.systemFont(ofSize: size, weight: semibold ? .semibold : .regular).fontDescriptor
        let serif = system.withDesign(.serif) ?? system
        let cascaded = serif.addingAttributes([.cascadeList: [UIFontDescriptor(name: chinese, size: size)]])
        return UIFont(descriptor: cascaded, size: size) as CTFont
        #else
        let system = NSFont.systemFont(ofSize: size, weight: semibold ? .semibold : .regular).fontDescriptor
        let serif = system.withDesign(.serif) ?? system
        let cascaded = serif.addingAttributes([.cascadeList: [NSFontDescriptor(name: chinese, size: size)]])
        return (NSFont(descriptor: cascaded, size: size) ?? NSFont.systemFont(ofSize: size)) as CTFont
        #endif
    }
}

struct AnswerType: ViewModifier {
    let token: TypeToken
    var semibold = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func body(content: Content) -> some View {
        let ratio = TextScale.ratio(for: dynamicTypeSize, style: .body)
        content
            .font(Font(AnswerFont.make(size: token.size * ratio, semibold: semibold)))
            .tracking(token.tracking)
            .hmLineHeight(token.lineHeight.map { $0 * ratio })
    }
}

extension View {
    func answerType(_ token: TypeToken, semibold: Bool = false) -> some View {
        modifier(AnswerType(token: token, semibold: semibold))
    }
}
