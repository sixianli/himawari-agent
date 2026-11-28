import CoreText
import Foundation
import Testing
@testable import HimawariChat

@MainActor
struct AnswerFontTests {
    private func fontName(for text: String, semibold: Bool) -> String {
        let font = AnswerFont.make(size: 17, semibold: semibold)
        let used = CTFontCreateForString(font, text as CFString, CFRange(location: 0, length: (text as NSString).length))
        return CTFontCopyPostScriptName(used) as String
    }

    @Test func bundledSongStyleFontsRegister() {
        #expect(AnswerFont.registered)
    }

    @Test func chineseUsesTheBundledSerifAndLatinUsesNewYork() {
        #expect(fontName(for: "价", semibold: false) == AnswerFont.chineseRegular)
        #expect(fontName(for: "价", semibold: true) == AnswerFont.chineseSemibold)
        #expect(fontName(for: "HTTP", semibold: false).contains("NewYork"))
    }

    @Test func aCharacterOutsideTheBundledSetStillDraws() {
        let name = fontName(for: "喆", semibold: false)
        #expect(!name.isEmpty)
        #expect(name != AnswerFont.chineseRegular)
    }
}
