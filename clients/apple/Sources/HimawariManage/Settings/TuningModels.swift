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

    var changeType: String {
        switch self {
        case .think: "think.settings.change"
        case .delivery: "delivery_timing.settings.change"
        }
    }
}

public struct TuningItem: Decodable, Sendable, Hashable, Identifiable {
    public let key: String
    public let value: Int
    public let defaultValue: Int
    public let minimum: Int
    public let maximum: Int
    public let unit: String?
    public let overridden: Bool

    public var id: String { key }

    public var isSwitch: Bool { minimum == 0 && maximum == 1 }

    public var step: Int {
        let span = max(1, maximum - minimum)
        var step = 1
        while span / (step * 10) >= 20 { step *= 10 }
        return step
    }
}

public struct TuningSnapshot: Decodable, Sendable, Equatable {
    public let revision: Int
    public let enabled: Bool?
    public let items: [TuningItem]

    public var isEnabled: Bool { enabled ?? true }
}
