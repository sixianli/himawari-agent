import Foundation

public enum SenseItem: String, Codable, Sendable, CaseIterable, Identifiable {
    case location
    case calendar
    case health
    case contacts
    case photos
    case clipboard

    public var id: String { rawValue }

    public var serverSense: String? {
        switch self {
        case .location: "location"
        case .calendar, .contacts: nil
        case .health: "body"
        case .photos: "vision"
        case .clipboard: "reading"
        }
    }

    public var recordTypes: [String] {
        switch self {
        case .location: ["location.visit", "location.region"]
        case .health: ["health.sample", "motion.activity"]
        case .photos: ["photo.asset", "photo.screenshot"]
        case .clipboard: ["clipboard.item"]
        case .calendar, .contacts: []
        }
    }

    public var mirrorKind: String? {
        switch self {
        case .calendar: "calendar_event"
        case .contacts: "contact"
        default: nil
        }
    }

    public var retentionKey: String? {
        switch self {
        case .location: "track"
        default: nil
        }
    }

    public var isMirror: Bool { mirrorKind != nil }
}

public enum SenseAuthorization: String, Codable, Sendable, Equatable {
    case notAsked
    case allowed
    case limited
    case denied
    case restricted
    case unavailable

    public var permitsReading: Bool { self == .allowed || self == .limited }
}

public enum SenseState: Sendable, Equatable {
    case on
    case off
    case systemDenied
    case serverPaused
    case serverUnsupported
}

public struct SenseServerView: Sendable, Equatable {
    public let state: String
    public let enabledSenses: Set<String>
    public let knownTypes: Set<String>?

    public init(state: String, enabledSenses: Set<String>, knownTypes: Set<String>?) {
        self.state = state
        self.enabledSenses = enabledSenses
        self.knownTypes = knownTypes
    }

    public static func from(_ configuration: DeviceConfiguration?) -> SenseServerView? {
        guard let perception = configuration?.perception, let state = perception.state, let senses = perception.senses else { return nil }
        return SenseServerView(
            state: state,
            enabledSenses: Set(senses.filter(\.enabled).map(\.sense)),
            knownTypes: perception.recordTypes.map { Set($0.keys) }
        )
    }

    public func supports(_ item: SenseItem) -> Bool {
        guard let knownTypes else { return true }
        return item.recordTypes.allSatisfy(knownTypes.contains)
    }

    public func allows(_ item: SenseItem) -> Bool {
        guard let sense = item.serverSense else { return true }
        return enabledSenses.contains(sense)
    }
}

public enum SenseStateRule {
    public static func state(
        item: SenseItem,
        switchedOn: Bool,
        authorization: SenseAuthorization,
        server: SenseServerView?
    ) -> SenseState {
        if let server, !server.supports(item) { return .serverUnsupported }
        guard switchedOn else { return .off }
        switch authorization {
        case .denied, .restricted, .unavailable: return .systemDenied
        case .notAsked: return .off
        case .allowed, .limited: break
        }
        guard let server else { return .on }
        if !server.allows(item) { return .off }
        if server.state == "paused" { return .serverPaused }
        return .on
    }

    public static func collects(_ state: SenseState) -> Bool {
        state == .on
    }

    public enum Opening: Sendable, Equatable {
        case showIntro
        case askSystem
        case showDenied
        case needsServerSense
        case ready
    }

    public static func opening(
        item: SenseItem,
        introSeen: Bool,
        authorization: SenseAuthorization,
        server: SenseServerView?
    ) -> Opening {
        switch authorization {
        case .denied, .restricted: return .showDenied
        case .unavailable: return .showDenied
        case .notAsked: return introSeen ? .askSystem : .showIntro
        case .allowed, .limited:
            if let server, !server.allows(item) { return .needsServerSense }
            return .ready
        }
    }
}

public struct SenseSwitchState: Codable, Sendable, Equatable {
    public var on: Bool
    public var introSeen: Bool
    public var askedAlways: Bool

    public init(on: Bool = false, introSeen: Bool = false, askedAlways: Bool = false) {
        self.on = on
        self.introSeen = introSeen
        self.askedAlways = askedAlways
    }
}

public final class SenseSwitches: @unchecked Sendable {
    private let store: LocalStore
    private let lock = NSLock()
    static let name = "sense-switches"

    public init(store: LocalStore) {
        self.store = store
    }

    public func state(_ item: SenseItem) -> SenseSwitchState {
        lock.withLock { all()[item] ?? SenseSwitchState() }
    }

    public func update(_ item: SenseItem, _ change: (inout SenseSwitchState) -> Void) throws {
        try lock.withLock {
            var states = all()
            var state = states[item] ?? SenseSwitchState()
            change(&state)
            states[item] = state
            let encoded = Dictionary(uniqueKeysWithValues: states.map { ($0.key.rawValue, $0.value) })
            try store.write(Self.name, try JSONEncoder().encode(encoded))
        }
    }

    private func all() -> [SenseItem: SenseSwitchState] {
        guard
            let data = store.read(Self.name),
            let raw = try? JSONDecoder().decode([String: SenseSwitchState].self, from: data)
        else { return [:] }
        var result: [SenseItem: SenseSwitchState] = [:]
        for (key, value) in raw {
            if let item = SenseItem(rawValue: key) { result[item] = value }
        }
        return result
    }
}
