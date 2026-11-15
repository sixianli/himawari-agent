import Foundation

public enum OwnerLocale: String, CaseIterable, Sendable {
    case zhCN = "zh-CN"
    case en
    case ja
}

public struct OwnerPreferences: Decodable, Sendable, Equatable {
    public let name: String?
    public let locale: String?
    public let accent: String?
    public let theme: String?
    public let modelRef: String?
    public let thinkingLevel: String?
    public let revision: Int
    public let updatedAt: String?

    public static let nameLimit = 40

    public static func clampedName(_ text: String) -> String {
        var result = ""
        var units = 0
        for character in text where !character.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) {
            let width = String(character).utf16.count
            if units + width > nameLimit { break }
            result.append(character)
            units += width
        }
        return result
    }

    public func change(name draftName: String, locale draftLocale: OwnerLocale?) -> OwnerPreferencesChange? {
        let trimmed = Self.clampedName(draftName.trimmingCharacters(in: .whitespacesAndNewlines))
        let nextName: String? = trimmed.isEmpty ? nil : trimmed
        let nextLocale = draftLocale?.rawValue ?? locale
        guard nextName != name || nextLocale != locale else { return nil }
        return OwnerPreferencesChange(
            name: nextName,
            locale: nextLocale,
            accent: accent,
            theme: theme,
            modelRef: modelRef,
            thinkingLevel: thinkingLevel,
            expectedRevision: revision
        )
    }
}

public struct OwnerPreferencesChange: Encodable, Sendable, Equatable {
    public let name: String?
    public let locale: String?
    public let accent: String?
    public let theme: String?
    public let modelRef: String?
    public let thinkingLevel: String?
    public let expectedRevision: Int

    private enum CodingKeys: String, CodingKey {
        case name, locale, accent, theme, modelRef, thinkingLevel, expectedRevision
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(locale, forKey: .locale)
        try container.encode(accent, forKey: .accent)
        try container.encode(theme, forKey: .theme)
        try container.encode(modelRef, forKey: .modelRef)
        try container.encode(thinkingLevel, forKey: .thinkingLevel)
        try container.encode(expectedRevision, forKey: .expectedRevision)
    }
}
