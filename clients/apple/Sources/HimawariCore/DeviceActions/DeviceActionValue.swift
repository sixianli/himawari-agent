import Foundation

public enum DeviceActionValue: Codable, Sendable, Equatable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([DeviceActionValue])
    case object([String: DeviceActionValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([DeviceActionValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: DeviceActionValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .number(value):
            if value.rounded() == value, abs(value) < 9_007_199_254_740_992 {
                try container.encode(Int64(value))
            } else {
                try container.encode(value)
            }
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }

    public var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var bool: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    public var number: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    public var integer: Int? {
        guard case let .number(value) = self, value.rounded() == value, abs(value) <= Double(Int32.max) else { return nil }
        return Int(value)
    }

    public var strings: [String]? {
        guard case let .array(items) = self else { return nil }
        let values = items.compactMap(\.string)
        return values.count == items.count ? values : nil
    }

    public var object: [String: DeviceActionValue]? {
        if case let .object(value) = self { return value }
        return nil
    }
}

public typealias JSONObject = [String: DeviceActionValue]
