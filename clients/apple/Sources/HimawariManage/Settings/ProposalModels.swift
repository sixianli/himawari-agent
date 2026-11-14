import Foundation

public struct ProposalSource: Decodable, Sendable, Hashable {
    public let kind: String
    public let ref: String
}

public struct ProposalFigure: Decodable, Sendable, Hashable {
    public let name: String
    public let value: Int
    public let definition: String
}

public struct ProposalEvidence: Decodable, Sendable, Hashable {
    public let kind: String
    public let text: String?
    public let sources: [ProposalSource]
    public let figures: [ProposalFigure]
}

public struct Proposal: Decodable, Sendable, Identifiable, Hashable {
    public let proposalId: String
    public let version: Int
    public let fingerprint: String
    public let type: String
    public let summary: String
    public let effect: String
    public let origin: String
    public let adoptable: Bool
    public let evidence: [ProposalEvidence]
    public let proposedAt: String
    public let expiresAt: String
    public let refusedBefore: Int

    public var id: String { proposalId }

    public var hasEvidence: Bool {
        evidence.contains { ($0.text?.isEmpty == false) || !$0.figures.isEmpty }
    }
}

public struct ProposalList: Decodable, Sendable, Equatable {
    public let proposals: [Proposal]
    public let pendingCount: Int
    public let limit: Int
    public let expiresAfterDays: Int
}

public enum ProposalAction: String, Sendable {
    case adopt
    case reject
}

public enum ProposalOutcome: Equatable, Sendable {
    case done(ProposalAction)
    case changed(Proposal)
    case gone
}
