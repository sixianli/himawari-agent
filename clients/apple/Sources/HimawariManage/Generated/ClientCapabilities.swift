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

public struct ClientItemTighten: Sendable, Hashable {
    public let key: String
    public let equals: [String: String]
    public let nulls: [String]
    public let openKeys: [String]

    func accepts(_ payload: JSONValue) -> Bool {
        guard case .object(let fields) = payload, fields.count == 1, case .array(let items)? = fields[key], !items.isEmpty else {
            return false
        }
        let expectedKeys = Set(equals.keys).union(nulls).union(openKeys)
        return items.allSatisfy { item in
            guard case .object(let entry) = item, Set(entry.keys) == expectedKeys else { return false }
            return equals.allSatisfy { entry[$0.key] == JSONValue.string($0.value) }
                && nulls.allSatisfy { entry[$0] == JSONValue.null }
        }
    }
}

public struct ClientCapability: Sendable, Hashable {
    public let gateway: ClientGateway
    public let type: String
    public let kind: ClientRequestKind
    public let tier: ClientCapabilityTier
    public let tightenPayload: [String: Bool]?
    public let tightenOpenKeys: [String]
    public let tightenEveryItem: ClientItemTighten?

    public func requiredTier(payload: JSONValue) -> ClientCapabilityTier {
        if let tightenEveryItem, tightenEveryItem.accepts(payload) { return .tighten }
        guard
            let tightenPayload,
            Set(tightenOpenKeys).isSubset(of: payload.keys),
            let flags = payload.flags(ignoring: tightenOpenKeys)
        else { return tier }
        return flags == tightenPayload ? .tighten : tier
    }
}

public enum NativePage: String, Sendable, CaseIterable {
    case chat = "chat"
    case memory = "memory"
    case memoryReflection = "memory.reflection"
    case settingsAuthorizations = "settings.authorizations"
    case settingsDevices = "settings.devices"
}

public enum ClientCapabilities {
    public static let all: [ClientCapability] = [
        ClientCapability(gateway: .v1, type: "trigger.admit", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v1, type: "thread.create", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v1, type: "thread.close", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v1, type: "run.cancel", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v1, type: "approval.respond", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v1, type: "thread.get_snapshot", kind: .query, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v1, type: "run.get_snapshot", kind: .query, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v1, type: "trace.query", kind: .query, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "thread.message.submit", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "approval.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "approval.allowance.set", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "approval.allowance.days.set", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "approval.allowance.revoke", kind: .command, tier: .tighten, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "search.authorization.set", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "search.authorization.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "push.subscription.set", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "push.kind.set", kind: .command, tier: .change, tightenPayload: ["enabled": false], tightenOpenKeys: ["kind"], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "push.test", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "presence.heartbeat", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "push.feedback.record", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "push.status.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.overview.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.settings.set", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.pause", kind: .command, tier: .tighten, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.insight.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.decision.rate", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.audit.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.review.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.review.rate", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.review.checkup", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.source.manage", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.sources.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.source.settings.set", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.source.switch_off", kind: .command, tier: .tighten, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "muse.overview.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "muse.item.rate", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "muse.intake.set", kind: .command, tier: .change, tightenPayload: ["paused": true], tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "muse.data.clear", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.weekly.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.observation.start", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "proactive.gapcase.mark", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "owner.preferences.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "owner.preferences.set", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "quiet_hours.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "quiet_hours.set", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "perception.status.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "perception.day.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "perception.episode.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "perception.usage.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "perception.settings.change", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "perception.deletion.plan", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "perception.deletion.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "perception.records.delete", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "think.settings.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "think.settings.change", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "timers.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "timers.change", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "sensitive.interceptions.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "sensitive.interceptions.clear", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.overview.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.basis.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "decision.chain.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "decision.email.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.approval.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.tidy.undo", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.reminder.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.reminder.create", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.rules.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.rule.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.create", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.category.set", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.settings.set", kind: .command, tier: .change, tightenPayload: ["capturePaused": true], tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.page.viewed", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.person.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.external.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: ClientItemTighten(key: "items", equals: ["decision": "reject"], nulls: ["editedText"], openKeys: ["proposalId"])),
        ClientCapability(gateway: .v2, type: "memory.external.undo", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.mcpSync.projectDecide", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.mcpSync.noteDecide", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.mcpSync.attentionResolve", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.conversationReview.undo", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.review.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.review.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.review.reportMissed", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.classify.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "home.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "search.ask.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "device.list.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "device.rename", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "device.revoke", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "server.status.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "login.devices.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "login.device.revoke", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "login.devices.revoke_others", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "mcp.connections.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "mcp.connection.create", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "mcp.connection.change", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "mcp.connection.rotate", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "files.list.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "data.export.start", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "data.export.cancel", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "data.export.status.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.import.duplicates.read", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.import.commit", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.import.undo", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "github.monitor.set_state", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "memory.mutate", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "grant.revoke", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "capability.review", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "capability.install.approve", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "capability.update.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "capability.disable", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "capability.reactivate", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "capability.rollback", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "host.file.prepare", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "host.file.execute", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "workspace.copy.create", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "workspace.copy.prepare", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "workspace.copy.select", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "workspace.stage", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "workspace.commit", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "suggestion.respond", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "reflection.configure", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "improvement.review", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "thread.list", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "approval.list", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "approval.detail", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "capability.list", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "capability.detail", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "grant.list", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "grant.detail", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "host.directory.detail", kind: .query, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "workspace.detail", kind: .query, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "workspace.list", kind: .query, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "suggestion.list", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "suggestion.detail", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "reflection.detail", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "delegation.detail", kind: .query, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "delegation.list", kind: .query, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "improvement.list", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .v2, type: "improvement.detail", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.create", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.message.submit", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.message.submit_configured", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.run.cancel", kind: .command, tier: .tighten, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.message.commit_assistant", kind: .command, tier: .notOnPhone, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.rename", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.pin", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.archive", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.restore", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.fork", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.set_answer_locale", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.trash", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.delete_permanently", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.task.resolve", kind: .command, tier: .routine, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.option.choose", kind: .command, tier: .change, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.deletion_impact", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.list", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.detail", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.main", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.execution", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.execution_state", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.execution_environment", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.background_work", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.search", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.lineage", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
        ClientCapability(gateway: .threadV3, type: "thread.checkpoint", kind: .query, tier: .read, tightenPayload: nil, tightenOpenKeys: [], tightenEveryItem: nil),
    ]

    public static let referencePlaceholder = "device"
    public static let serverFilledReferences = ["authorizationRef", "recentAuthenticationRef"]
    public static let allowanceDays: ClosedRange<Int> = 1...90
    public static let memoryTrashDays = 7

    public static func find(_ gateway: ClientGateway, _ type: String) -> ClientCapability? {
        all.first { $0.gateway == gateway && $0.type == type }
    }
}
