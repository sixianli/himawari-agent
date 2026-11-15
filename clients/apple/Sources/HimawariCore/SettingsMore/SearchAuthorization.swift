import Foundation

public struct SearchAuthorization: Decodable, Sendable, Equatable {
    public let revision: Int
    public let enabled: Bool
    public let providersChanged: Bool
    public let available: Bool
    public let recipients: [String]

    public var canSwitch: Bool { enabled || available }

    public var recipientHosts: [String] {
        var seen = Set<String>()
        return recipients.compactMap { origin in
            let host = URL(string: origin)?.host ?? origin
            return seen.insert(host).inserted ? host : nil
        }
    }

    public func setting(enabled next: Bool) -> SearchAuthorizationChange? {
        guard next != enabled, next ? available : true else { return nil }
        return SearchAuthorizationChange(expectedRevision: revision, enabled: next, recipients: recipients)
    }
}

public struct SearchAuthorizationChange: Encodable, Sendable, Equatable {
    public let expectedRevision: Int
    public let enabled: Bool
    public let recipients: [String]
}
