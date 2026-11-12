import Foundation

public enum ClientGateway: String, Sendable, CaseIterable {
    case v1 = "v1"
    case v2 = "v2"
    case threadV3 = "thread-v3"
}

public enum ClientRequestKind: String, Sendable {
    case query
    case command
}

public enum ClientCapabilityTier: String, Sendable {
    case read
    case routine
    case tighten
    case change
    case notOnPhone = "not_on_phone"
}

public struct ClientCapability: Sendable, Hashable {
    public let gateway: ClientGateway
    public let type: String
    public let kind: ClientRequestKind
    public let tier: ClientCapabilityTier
    public let tightenPayload: [String: Bool]?

    public func requiredTier(payloadFlags: [String: Bool]?) -> ClientCapabilityTier {
        guard let tightenPayload, let payloadFlags, payloadFlags == tightenPayload else { return tier }
        return .tighten
    }
}

public enum NativePage: String, Sendable, CaseIterable {
    case chat = "chat"
    case memory = "memory"
    case memoryReflection = "memory.reflection"
    case settingsAuthorizations = "settings.authorizations"
    case settingsCapabilities = "settings.capabilities"
    case settingsDevices = "settings.devices"
    case settingsHealth = "settings.health"
    case settingsImprovements = "settings.improvements"
    case settingsWorkers = "settings.workers"
    case settingsWorkspaces = "settings.workspaces"
    case todayApprovals = "today.approvals"
    case todaySuggestions = "today.suggestions"
}

public enum ClientCapabilities {
    public static let all: [ClientCapability] = [
        ClientCapability(gateway: .v1, type: "trigger.admit", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v1, type: "thread.create", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v1, type: "thread.close", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v1, type: "run.cancel", kind: .command, tier: .tighten, tightenPayload: nil),
        ClientCapability(gateway: .v1, type: "approval.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v1, type: "thread.get_snapshot", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v1, type: "run.get_snapshot", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v1, type: "trace.query", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "thread.message.submit", kind: .command, tier: .notOnPhone, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "approval.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "search.authorization.set", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "search.authorization.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "push.subscription.set", kind: .command, tier: .notOnPhone, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "push.kind.set", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "push.test", kind: .command, tier: .notOnPhone, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "presence.heartbeat", kind: .command, tier: .notOnPhone, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "push.feedback.record", kind: .command, tier: .notOnPhone, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "push.status.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.overview.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.settings.set", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.insight.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.decision.rate", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.audit.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.review.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.review.rate", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.review.checkup", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.source.manage", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.backoff.restore", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "muse.overview.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "muse.item.rate", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "muse.intake.set", kind: .command, tier: .change, tightenPayload: ["paused": true]),
        ClientCapability(gateway: .v2, type: "muse.data.clear", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.weekly.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.observation.start", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "proactive.gapcase.mark", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "owner.preferences.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "owner.preferences.set", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "sensitive.interceptions.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "sensitive.interceptions.clear", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.overview.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.basis.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "decision.chain.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "decision.email.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.approval.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.tidy.undo", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.reminder.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.reminder.create", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.rules.read", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.rule.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.create", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.category.set", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.settings.set", kind: .command, tier: .change, tightenPayload: ["capturePaused": true]),
        ClientCapability(gateway: .v2, type: "memory.page.viewed", kind: .command, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.person.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.import.commit", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.import.undo", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "github.monitor.set_state", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "memory.mutate", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "grant.revoke", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "capability.review", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "capability.install.approve", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "capability.update.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "capability.disable", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "capability.rollback", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "host.file.prepare", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "host.file.execute", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "workspace.copy.create", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "workspace.copy.prepare", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "workspace.copy.select", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "workspace.stage", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "workspace.commit", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "suggestion.respond", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "reflection.configure", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "improvement.review", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "thread.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "approval.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "approval.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "capability.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "capability.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "grant.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "grant.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "host.directory.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "workspace.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "workspace.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "suggestion.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "suggestion.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "reflection.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "delegation.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "delegation.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "improvement.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .v2, type: "improvement.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.create", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.message.submit", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.message.submit_configured", kind: .command, tier: .notOnPhone, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.run.cancel", kind: .command, tier: .tighten, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.message.commit_assistant", kind: .command, tier: .notOnPhone, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.rename", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.pin", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.archive", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.restore", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.fork", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.set_answer_locale", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.trash", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.delete_permanently", kind: .command, tier: .change, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.task.resolve", kind: .command, tier: .routine, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.deletion_impact", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.list", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.detail", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.execution", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.execution_state", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.execution_environment", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.search", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.lineage", kind: .query, tier: .read, tightenPayload: nil),
        ClientCapability(gateway: .threadV3, type: "thread.checkpoint", kind: .query, tier: .read, tightenPayload: nil),
    ]

    public static func find(_ gateway: ClientGateway, _ type: String) -> ClientCapability? {
        all.first { $0.gateway == gateway && $0.type == type }
    }
}
