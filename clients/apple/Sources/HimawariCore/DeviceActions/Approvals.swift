import Foundation

public enum ApprovalStatus: String, Codable, Sendable {
    case pending
    case approved
    case denied
    case expired
}

public enum ApprovalResponse: Sendable, Equatable {
    case recorded(status: String)
    case changed
    case allowanceNotSaved
}

public struct PendingApproval: Codable, Sendable, Equatable, Identifiable {
    public struct AskedBecause: Codable, Sendable, Equatable {
        public let kind: String
        public let ruleId: String?
        public let ruleText: String?
    }

    public struct Origin: Codable, Sendable, Equatable {
        public let threadId: String
        public let threadTitle: String?
    }

    public struct Display: Codable, Sendable, Equatable {
        public let displayTitle: String?
        public let bodyPreview: String?
        public let askedBecause: AskedBecause
        public let origin: Origin?
    }

    public struct Intent: Codable, Sendable, Equatable {
        public let capabilityRef: String
        public let operation: String
        public let threadId: String
        public let runId: String
        public var intentId: String? = nil
        public var actionKind: String? = nil
        public var estimatedCostMicros: Int? = nil
        public var credentialOrAccessChange: Bool? = nil
        public var deterministicFactCodes: [String]? = nil
    }

    public let approvalRequestId: String
    public let revision: Int
    public let status: String
    public let semanticSnapshotHash: String
    public let finalRisk: String
    public let recentAuthenticationRequired: Bool
    public let requestedAt: String
    public let expiresAt: String
    public let decidedAt: String?
    public let display: Display?
    public let intent: Intent
    public let confirmLabel: LocalizedLine?
    public let declineLabel: LocalizedLine?

    public var id: String { approvalRequestId }

    public init(
        approvalRequestId: String,
        revision: Int,
        status: String,
        semanticSnapshotHash: String,
        finalRisk: String,
        recentAuthenticationRequired: Bool,
        requestedAt: String,
        expiresAt: String,
        decidedAt: String?,
        display: Display?,
        intent: Intent,
        confirmLabel: LocalizedLine?,
        declineLabel: LocalizedLine? = nil
    ) {
        self.approvalRequestId = approvalRequestId
        self.revision = revision
        self.status = status
        self.semanticSnapshotHash = semanticSnapshotHash
        self.finalRisk = finalRisk
        self.recentAuthenticationRequired = recentAuthenticationRequired
        self.requestedAt = requestedAt
        self.expiresAt = expiresAt
        self.decidedAt = decidedAt
        self.display = display
        self.intent = intent
        self.confirmLabel = confirmLabel
        self.declineLabel = declineLabel
    }

    public var title: String {
        display?.displayTitle ?? intent.operation
    }
}

public extension PendingApproval.Display {
    init(title: String?, body: String?, ruleText: String?, threadId: String?, threadTitle: String?) {
        self.init(
            displayTitle: title,
            bodyPreview: body,
            askedBecause: .init(kind: ruleText == nil ? "no_rule_allows" : "rule", ruleId: nil, ruleText: ruleText),
            origin: threadId.map { .init(threadId: $0, threadTitle: threadTitle) }
        )
    }
}

public enum ApprovalAllowFor: String, CaseIterable, Sendable {
    case once
    case thisTask = "this_task"
    case days
    case always
}

public enum ApprovalAllowanceLimit: Sendable, Equatable {
    case spending
    case credential
    case ownerPresence
    case asksEveryTime
}

public extension PendingApproval {
    static let allowanceIntentPrefix = "owner-scope:"

    var allowanceLimit: ApprovalAllowanceLimit? {
        if (intent.estimatedCostMicros ?? 0) > 0 || intent.actionKind == "PURCHASE_OR_FUNDS" { return .spending }
        if intent.credentialOrAccessChange ?? false { return .credential }
        if (intent.deterministicFactCodes ?? []).contains("owner_presence_required") { return .ownerPresence }
        guard intent.intentId?.hasPrefix(Self.allowanceIntentPrefix) == true else { return .asksEveryTime }
        return nil
    }

    func allowanceChoices(days: Int?) -> [ApprovalAllowFor] {
        guard allowanceLimit == nil else { return [.once] }
        return ApprovalAllowFor.allCases.filter { $0 != .days || days != nil }
    }
}
