import Foundation

public struct SearchBasis: Decodable, Sendable, Equatable, Identifiable {
    public enum Kind: String, Decodable, Sendable {
        case memory
        case conversation
        case perception
    }

    public let kind: Kind
    public let memoryId: String?
    public let threadId: String?
    public let recordId: String?
    public let at: String?
    public let label: String

    public var id: String { [kind.rawValue, memoryId, threadId, recordId, at, label].compactMap { $0 }.joined(separator: ":") }

    public init(kind: Kind, memoryId: String? = nil, threadId: String? = nil, recordId: String? = nil, at: String? = nil, label: String) {
        self.kind = kind
        self.memoryId = memoryId
        self.threadId = threadId
        self.recordId = recordId
        self.at = at
        self.label = label
    }
}

public struct SearchAnswer: Decodable, Sendable, Equatable {
    public enum State: String, Decodable, Sendable {
        case answered
        case notFound = "not_found"
        case suggestions
    }

    public let state: State
    public let query: String?
    public let answer: String?
    public let notFoundText: String?
    public let basis: [SearchBasis]
    public let asks: [String]

    enum CodingKeys: String, CodingKey { case state, query, answer, notFoundText, basis, asks }

    public init(state: State, query: String?, answer: String? = nil, notFoundText: String? = nil, basis: [SearchBasis] = [], asks: [String] = []) {
        self.state = state
        self.query = query
        self.answer = answer
        self.notFoundText = notFoundText
        self.basis = basis
        self.asks = asks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(State.self, forKey: .state)
        query = try c.decodeIfPresent(String.self, forKey: .query)
        answer = try c.decodeIfPresent(String.self, forKey: .answer)
        notFoundText = try c.decodeIfPresent(String.self, forKey: .notFoundText)
        basis = try c.decodeIfPresent([SearchBasis].self, forKey: .basis) ?? []
        asks = try c.decodeIfPresent([String].self, forKey: .asks) ?? []
    }

    private struct Envelope: Decodable { let payload: SearchAnswer }

    public static func decode(_ data: Data) throws -> SearchAnswer {
        try JSONDecoder().decode(Envelope.self, from: data).payload
    }

    public var shownAnswer: String? {
        guard state == .answered, let answer, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return answer
    }

    public var shownBasis: [SearchBasis] { shownAnswer == nil ? [] : basis }
}

public enum SearchQuestion {
    public static func trimmed(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
