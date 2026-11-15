import Foundation

public enum TuningKind: CaseIterable, Sendable {
    case think
    case delivery

    var readType: String {
        switch self {
        case .think: "think.settings.read"
        case .delivery: "delivery_timing.settings.read"
        }
    }

    var readPayload: JSONValue {
        switch self {
        case .think: [:]
        case .delivery: ["locale": .string(ManageLanguage.current.serverTag)]
        }
    }

    var changeType: String {
        switch self {
        case .think: "think.settings.change"
        case .delivery: "delivery_timing.settings.change"
        }
    }
}

extension ManageLanguage {
    var serverTag: String {
        switch self {
        case .zh: "zh-CN"
        case .ja: "ja"
        case .en: "en"
        }
    }
}

struct LocalizedText: Decodable, Sendable, Hashable {
    let value: String

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer().decode(String.self) {
            value = single
            return
        }
        let table = try decoder.singleValueContainer().decode([String: String].self)
        value = table[ManageLanguage.current.serverTag] ?? table["en"] ?? ""
    }
}

public struct TuningItem: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let value: Int
    public let defaultValue: Int
    public let minimum: Int
    public let maximum: Int
    public let overridden: Bool
    public let name: String
    public let note: String
    public let unit: String
    let kind: TuningValueKind?
    let storageUnit: TuningStorageUnit?

    public var id: String { key }

    public var isSwitch: Bool { minimum == 0 && maximum == 1 }

    public var step: Int {
        let span = max(1, maximum - minimum)
        var step = 1
        while span / (step * 10) >= 20 { step *= 10 }
        return step
    }

    private enum CodingKeys: String, CodingKey {
        case key, value, defaultValue, minimum, maximum, overridden, label, description, unit, unitLabel, kind, storageUnit
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        value = try container.decode(Int.self, forKey: .value)
        defaultValue = try container.decode(Int.self, forKey: .defaultValue)
        minimum = try container.decode(Int.self, forKey: .minimum)
        maximum = try container.decode(Int.self, forKey: .maximum)
        overridden = try container.decode(Bool.self, forKey: .overridden)
        name = (try container.decodeIfPresent(LocalizedText.self, forKey: .label))?.value ?? ""
        note = (try container.decodeIfPresent(LocalizedText.self, forKey: .description))?.value ?? ""
        let label = try container.decodeIfPresent(LocalizedText.self, forKey: .unitLabel)
        unit = label?.value ?? (try? container.decode(LocalizedText.self, forKey: .unit))?.value ?? ""
        kind = (try? container.decodeIfPresent(String.self, forKey: .kind)).flatMap(TuningValueKind.init(rawValue:))
        storageUnit = (try? container.decodeIfPresent(String.self, forKey: .storageUnit)).flatMap(TuningStorageUnit.init(rawValue:))
    }
}

public struct TuningSnapshot: Decodable, Sendable, Equatable {
    public let revision: Int
    public let enabled: Bool?
    public let items: [TuningItem]

    public var isEnabled: Bool { enabled ?? true }

    public var shown: [TuningItem] { items.filter { !$0.name.isEmpty } }
}
