import Foundation

public enum KeychainPresence: Sendable, Equatable {
    case present
    case absent
    case unreadable
}

public enum RestoreDecision: Sendable, Equatable {
    case unreadable
    case forget
    case use

    public static func decide(presence: [KeychainPresence], recordDecodes: Bool) -> RestoreDecision {
        if presence.contains(.unreadable) { return .unreadable }
        guard presence.allSatisfy({ $0 == .present }) else { return .forget }
        return recordDecodes ? .use : .unreadable
    }
}

public enum PairingAttempt {
    public static func mayHavePaired(_ error: Error) -> Bool {
        if error is PairingInvitation.ParseError || error is DeviceKeyError { return false }
        if case let .server(status, _, _)? = error as? DeviceAPIError { return status >= 500 || status == 408 || status == 429 }
        return true
    }
}

public enum ExecutionStreamPolicy {
    public static let streamsNeeded = 2

    public static func allowed(streamConnections: Int?) -> Bool {
        guard let streamConnections else { return true }
        return streamConnections >= streamsNeeded
    }
}

extension LocalStore {
    public static var ownerName: String { "owner" }

    public func claim(for owner: String) throws {
        let mark = Data(owner.utf8)
        if let current = read(Self.ownerName) {
            if current == mark { return }
        } else if contains(Self.ownerName) {
            throw LocalStoreError.unreadable(Self.ownerName)
        }
        try removeAll()
        try write(Self.ownerName, mark)
    }
}

public enum LocalStoreError: Error, Equatable {
    case unreadable(String)
    case retired
}

public enum ForgetOutcome {
    public static func problem(wanted: PairingProblem?, storeEmptied: Bool) -> PairingProblem? {
        if !storeEmptied, wanted == .removed { return nil }
        return wanted
    }
}
