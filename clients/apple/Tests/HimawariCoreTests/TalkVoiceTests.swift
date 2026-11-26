import Foundation
import HimawariCore
import Testing

struct TalkVoiceTests {
    private let mandarinDefault = TalkVoiceOption(identifier: "com.apple.voice.compact.zh-CN.Tingting", language: "zh-CN", quality: .standard)
    private let mandarinEnhanced = TalkVoiceOption(identifier: "com.apple.voice.enhanced.zh-CN.Tingting", language: "zh-CN", quality: .enhanced)
    private let mandarinPremium = TalkVoiceOption(identifier: "com.apple.voice.premium.zh-CN.Lilian", language: "zh-CN", quality: .premium)
    private let taiwanPremium = TalkVoiceOption(identifier: "com.apple.voice.premium.zh-TW.Meijia", language: "zh-TW", quality: .premium)
    private let englishPremium = TalkVoiceOption(identifier: "com.apple.voice.premium.en-US.Zoe", language: "en-US", quality: .premium)

    @Test func premiumBeatsEnhancedBeatsDefault() {
        let pick = TalkVoices.pick(from: [mandarinDefault, mandarinEnhanced, mandarinPremium], preferred: "zh-Hans-JP")
        #expect(pick.voice == mandarinPremium)
        #expect(!pick.suggestsDownload)
        let withoutPremium = TalkVoices.pick(from: [mandarinDefault, mandarinEnhanced], preferred: "zh-Hans")
        #expect(withoutPremium.voice == mandarinEnhanced)
        #expect(!withoutPremium.suggestsDownload)
    }

    @Test func onlyDefaultVoiceSuggestsDownload() {
        let pick = TalkVoices.pick(from: [mandarinDefault, englishPremium], preferred: "zh-Hans-CN")
        #expect(pick.voice == mandarinDefault)
        #expect(pick.suggestsDownload)
    }

    @Test func otherScriptOrLanguagePremiumIsNotChosen() {
        let pick = TalkVoices.pick(from: [mandarinDefault, taiwanPremium, englishPremium], preferred: "zh-Hans")
        #expect(pick.voice == mandarinDefault)
        #expect(pick.suggestsDownload)
    }

    @Test func noVoiceForLanguageSuggestsDownload() {
        let pick = TalkVoices.pick(from: [englishPremium], preferred: "zh-Hans")
        #expect(pick.voice == nil)
        #expect(pick.suggestsDownload)
    }
}
