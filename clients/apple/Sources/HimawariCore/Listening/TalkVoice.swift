import Foundation

public enum TalkVoiceQuality: Int, Sendable, Comparable {
    case standard = 1
    case enhanced = 2
    case premium = 3

    public static func < (lhs: TalkVoiceQuality, rhs: TalkVoiceQuality) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

public struct TalkVoiceOption: Sendable, Equatable {
    public let identifier: String
    public let language: String
    public let quality: TalkVoiceQuality

    public init(identifier: String, language: String, quality: TalkVoiceQuality) {
        self.identifier = identifier
        self.language = language
        self.quality = quality
    }
}

public struct TalkVoicePick: Sendable, Equatable {
    public let voice: TalkVoiceOption?
    public let suggestsDownload: Bool
}

public enum TalkVoices {
    public static func pick(from voices: [TalkVoiceOption], preferred: String) -> TalkVoicePick {
        let wanted = Spoken(preferred)
        let sameLanguage = voices.filter { Spoken($0.language).code == wanted.code }
        let sameScript = sameLanguage.filter { Spoken($0.language).script == wanted.script }
        let candidates = sameScript.isEmpty ? sameLanguage : sameScript
        let best = candidates.max { lhs, rhs in
            rank(lhs, wanted) < rank(rhs, wanted)
        }
        return TalkVoicePick(voice: best, suggestsDownload: (best?.quality ?? .standard) == .standard)
    }

    private static func rank(_ voice: TalkVoiceOption, _ wanted: Spoken) -> (Int, Int, String) {
        let region = Spoken(voice.language).region == wanted.region ? 1 : 0
        return (voice.quality.rawValue, region, voice.identifier)
    }

    private struct Spoken {
        let code: String?
        let script: String?
        let region: String?

        init(_ identifier: String) {
            let language = Locale.Language(identifier: identifier.replacingOccurrences(of: "_", with: "-"))
            let maximal = Locale.Language(identifier: language.maximalIdentifier)
            code = language.languageCode?.identifier.lowercased()
            script = maximal.script?.identifier.lowercased()
            region = maximal.region?.identifier.uppercased()
        }
    }
}
