import Testing
@testable import HimawariCore

@Suite struct TextSearchTests {
    @Test func everyWordTypedMustAppearSomewhereInTheMemory() {
        #expect(TextSearch.matches("主人讨厌喝热水。", query: "热水"))
        #expect(TextSearch.matches("主人爱喝美式咖啡，不加糖", query: "咖啡 糖"))
        #expect(!TextSearch.matches("主人爱喝美式咖啡，不加糖", query: "咖啡 热水"))
    }

    @Test func caseAndFullWidthLettersDoNotMatter() {
        #expect(TextSearch.matches("Andy uses an iPhone", query: "IPHONE"))
        #expect(TextSearch.matches("Andy uses an iPhone", query: "ｉｐｈｏｎｅ"))
    }

    @Test func anEmptySearchShowsEverythingAndANonsenseSearchShowsNothing() {
        #expect(TextSearch.matches("任何一条", query: "   "))
        #expect(!TextSearch.matches("主人讨厌布洛芬。", query: "火星"))
    }
}
