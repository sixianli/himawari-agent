import Foundation

public enum DevicePermissionStatus: String, Sendable, Equatable {
    case authorized
    case notDetermined
    case denied
    case unavailable
}

public protocol DevicePermission: Sendable {
    var id: String { get }
    var name: LocalizedLine { get }
    var settingsPath: LocalizedLine { get }
    var purpose: LocalizedLine { get }
    var shownToOwner: Bool { get }
    func status() async -> DevicePermissionStatus
    func request() async -> DevicePermissionStatus
}

public extension DevicePermission {
    var shownToOwner: Bool { true }
}

public enum DeviceActionReading: Sendable, Equatable {
    case matches(JSONObject)
    case differs(JSONObject)
    case unreadable
}

public struct DeviceActionFailure: Error, Sendable, Equatable {
    public let reason: DeviceActionReason

    public init(_ reason: DeviceActionReason) {
        self.reason = reason
    }
}

public protocol DeviceActionHandler: Sendable {
    var names: [String] { get }
    var permission: DevicePermission { get }
    func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject?
    func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject
    func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading
    var readOnly: Set<String> { get }
    var schemaVersions: Set<Int> { get }
}

public extension DeviceActionHandler {
    var readOnly: Set<String> { [] }
    var schemaVersions: Set<Int> { [1] }

    func handles(_ delivery: DeviceActionDelivery) -> Bool {
        names.contains(delivery.action) && schemaVersions.contains(delivery.schemaVersion)
    }
}

public struct DeviceActionArguments: Sendable {
    public let values: JSONObject

    public init(_ values: JSONObject) {
        self.values = values
    }

    public func string(_ key: String) throws -> String {
        guard let value = values[key]?.string, !value.isEmpty else { throw DeviceActionFailure(.badArguments) }
        return value
    }

    public func optionalString(_ key: String) throws -> String? {
        guard let value = values[key] else { return nil }
        guard let text = value.string else { throw DeviceActionFailure(.badArguments) }
        return text
    }

    public func optionalBool(_ key: String) throws -> Bool? {
        guard let value = values[key] else { return nil }
        guard let flag = value.bool else { throw DeviceActionFailure(.badArguments) }
        return flag
    }

    public func optionalNumber(_ key: String) throws -> Double? {
        guard let value = values[key] else { return nil }
        guard let number = value.number else { throw DeviceActionFailure(.badArguments) }
        return number
    }

    public func optionalInteger(_ key: String) throws -> Int? {
        guard let value = values[key] else { return nil }
        guard let number = value.integer else { throw DeviceActionFailure(.badArguments) }
        return number
    }

    public func optionalStrings(_ key: String) throws -> [String]? {
        guard let value = values[key] else { return nil }
        guard let items = value.strings else { throw DeviceActionFailure(.badArguments) }
        return items
    }

    public func localDate(_ key: String, in timeZone: TimeZone = .current) throws -> Date {
        guard let date = DeviceActionTime.localDate(try string(key), in: timeZone) else { throw DeviceActionFailure(.badArguments) }
        return date
    }

    public func optionalLocalDate(_ key: String, in timeZone: TimeZone = .current) throws -> Date? {
        guard let text = try optionalString(key) else { return nil }
        guard let date = DeviceActionTime.localDate(text, in: timeZone) else { throw DeviceActionFailure(.badArguments) }
        return date
    }
}

public extension DeviceActionDelivery {
    var args: DeviceActionArguments { DeviceActionArguments(arguments) }
}

public enum DeviceActionReason: Sendable, Equatable {
    case notSupported
    case blockedByPolicy
    case expired
    case permission(LocalizedLine, settings: LocalizedLine)
    case permissionNotAsked(LocalizedLine)
    case permissionUnavailable(LocalizedLine)
    case badArguments
    case targetMissing
    case snapshotFailed
    case readBackDiffers
    case notDoneOnCheck
    case cannotCheck
    case cannotChange(LocalizedLine)
    case system(String)

    public func text(_ locale: AnswerLocale = .matching(preferredLanguages: Locale.preferredLanguages)) -> String {
        switch self {
        case .notSupported:
            return Self.pick(locale, "这台设备不会做这件事", "This device can't do this", "この端末ではこれはできません")
        case .blockedByPolicy:
            return Self.pick(locale, "这台设备的设置里没有允许这件事", "This device's settings don't allow this", "この端末の設定で許可されていません")
        case .expired:
            return Self.pick(locale, "送到时已经过期，没有做", "It had expired when it arrived, so nothing was done", "届いた時点で期限切れだったので、何もしていません")
        case let .permission(name, settings):
            let what = name.localized(locale)
            let path = settings.localized(locale)
            return Self.pick(
                locale,
                "系统里没允许 Himawari 使用\(what)，可以在\(path)里打开",
                "Himawari isn't allowed to use \(what). You can turn it on in \(path)",
                "Himawari に\(what)の使用が許可されていません。\(path)でオンにできます"
            )
        case let .permissionNotAsked(name):
            let what = name.localized(locale)
            return Self.pick(
                locale,
                "Himawari 还没问过能不能用\(what)。在 Himawari 的设置 › 系统里允许的 里点\(what)，再点“继续”",
                "Himawari hasn't asked to use \(what) yet. In Himawari's settings, under Allowed in the system, tap \(what) and then Continue",
                "Himawari はまだ\(what)の使用を確認していません。Himawari の設定の「システムで許可されているもの」で\(what)をタップし、「続ける」を押してください"
            )
        case let .permissionUnavailable(name):
            let what = name.localized(locale)
            return Self.pick(
                locale,
                "这台设备上\(what)用不了，可能被屏幕使用时间或描述文件限制了",
                "\(what) isn't available on this device; Screen Time or a profile may restrict it",
                "この端末では\(what)を使えません。スクリーンタイムやプロファイルで制限されている可能性があります"
            )
        case .badArguments:
            return Self.pick(locale, "要做的内容这台设备读不懂，没有做", "This device couldn't read what to do, so nothing was done", "内容を読み取れなかったので、何もしていません")
        case .targetMissing:
            return Self.pick(locale, "要动的那一项在这台设备上找不到了", "The item to change is no longer on this device", "対象の項目がこの端末に見つかりません")
        case .snapshotFailed:
            return Self.pick(locale, "动之前存不下原来的样子，所以没有动", "Couldn't save how it was before, so nothing was changed", "変更前の状態を保存できなかったので、変更していません")
        case .readBackDiffers:
            return Self.pick(locale, "做完读回来，和要做的不一样", "After doing it, what was read back didn't match", "実行後に読み返した内容が一致しませんでした")
        case .notDoneOnCheck:
            return Self.pick(locale, "核对过，这件事没有做成", "Checked: this wasn't done", "確認したところ、実行されていません")
        case .cannotCheck:
            return Self.pick(locale, "这台设备核对不出做没做成", "This device couldn't tell whether it was done", "この端末では実行されたか確認できません")
        case let .cannotChange(part):
            let what = part.localized(locale)
            return Self.pick(locale, "这台设备的系统不让 App 改\(what)，没有做", "This device's system doesn't let apps change \(what), so nothing was done", "この端末のシステムではアプリから\(what)を変更できないため、何もしていません")
        case let .system(message):
            return message
        }
    }

    static func pick(_ locale: AnswerLocale, _ chinese: String, _ english: String, _ japanese: String) -> String {
        switch locale {
        case .chinese: chinese
        case .english: english
        case .japanese: japanese
        }
    }
}

public enum CalendarOccurrenceId {
    public static let separator: Character = "#"

    public static func make(eventIdentifier: String, start: Date, in timeZone: TimeZone = .current) -> String {
        "\(eventIdentifier)\(separator)\(DeviceActionTime.localText(start, in: timeZone))"
    }

    public static func of(eventIdentifier: String, start: Date, recurring: Bool, in timeZone: TimeZone = .current) -> String {
        recurring ? make(eventIdentifier: eventIdentifier, start: start, in: timeZone) : eventIdentifier
    }

    public static func split(_ id: String, in timeZone: TimeZone = .current) -> (eventIdentifier: String, start: Date?) {
        guard let index = id.lastIndex(of: separator),
              let start = DeviceActionTime.localDate(String(id[id.index(after: index)...]), in: timeZone) else {
            return (id, nil)
        }
        return (String(id[..<index]), start)
    }
}

public enum DeviceActionListing {
    public static func fit(_ items: [JSONObject], as key: String, within limit: Int?) -> JSONObject {
        guard let limit else { return [key: .array(items.map(DeviceActionValue.object)), "truncated": .bool(false)] }
        var kept: [DeviceActionValue] = []
        var used = size(of: ["done": .object([key: .array([]), "truncated": .bool(false)])]) ?? 0
        for item in items {
            guard let encoded = size(of: item) else { continue }
            let added = encoded + (kept.isEmpty ? 0 : 1)
            if used + added > limit { return [key: .array(kept), "truncated": .bool(true)] }
            used += added
            kept.append(.object(item))
        }
        return [key: .array(kept), "truncated": .bool(false)]
    }

    static func size(of evidence: JSONObject) -> Int? {
        try? JSONEncoder().encode(evidence).count
    }
}
