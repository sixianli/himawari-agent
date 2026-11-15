import Foundation
import HimawariCore
import Observation

@MainActor
@Observable
public final class MoreSettingsStore {
    public private(set) var preferences: OwnerPreferences?
    public private(set) var mcp: McpConnections?
    public private(set) var search: SearchAuthorization?
    public private(set) var push: PushStatus?
    public private(set) var muse: MuseOverview?
    public private(set) var sensitiveCounts: SensitiveCounts?
    public private(set) var sensitiveItems: [SensitiveItem] = []
    public private(set) var sensitiveNext: SensitiveCursor?
    public private(set) var sensitiveFailed = false

    @ObservationIgnored let gateway: ManageGateway

    public init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    public func loadAll() async {
        async let preferences: Void = loadPreferences()
        async let mcp: Void = loadMcp()
        async let search: Void = loadSearch()
        async let push: Void = loadPush()
        async let muse: Void = loadMuse()
        async let sensitive: Void = loadSensitive()
        _ = await (preferences, mcp, search, push, muse, sensitive)
    }

    private func read<T: Decodable>(_ type: String, payload: JSONValue = [:], as _: T.Type) async throws -> T {
        let data = try await gateway.read(.v2, type, payload: payload)
        return try JSONDecoder().decode(Snapshot<T>.self, from: data).payload
    }

    private func send<Body: Encodable>(
        _ type: String,
        _ body: Body,
        risk: String = "medium",
        reason: String
    ) async throws {
        let payload = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(body))
        _ = try await gateway.command(.v2, type, payload: payload, options: ManageCommandOptions(risk: risk, confirmReason: reason))
    }

    public func loadPreferences() async {
        if let value = try? await read("owner.preferences.read", as: OwnerPreferences.self) { preferences = value }
    }

    public func savePreferences(name: String, locale: OwnerLocale?, reason: String) async throws {
        guard let change = preferences?.change(name: name, locale: locale) else { return }
        defer { Task { await loadPreferences() } }
        try await send("owner.preferences.set", change, reason: reason)
    }

    public func loadMcp() async {
        if let value = try? await read("mcp.connections.read", as: McpConnections.self) { mcp = value }
    }

    public func changeMcp(_ change: McpConnectionChange, reason: String) async throws {
        defer { Task { await loadMcp() } }
        try await send("mcp.connection.change", change, reason: reason)
    }

    public func loadSearch() async {
        if let value = try? await read("search.authorization.read", as: SearchAuthorization.self) { search = value }
    }

    public func setSearch(enabled: Bool, reason: String) async throws {
        guard let change = search?.setting(enabled: enabled) else { return }
        defer { Task { await loadSearch() } }
        try await send("search.authorization.set", change, risk: "high", reason: reason)
    }

    public func loadPush() async {
        if let value = try? await read("push.status.read", as: PushStatus.self) { push = value }
    }

    public func setPushKind(_ kind: String, enabled: Bool, reason: String) async throws {
        guard let change = push?.setting(kind, enabled: enabled) else { return }
        defer { Task { await loadPush() } }
        try await send("push.kind.set", change, reason: reason)
    }

    public func loadMuse() async {
        if let value = try? await read("muse.overview.read", as: MuseOverview.self) { muse = value }
    }

    public func rate(_ item: MuseItem, timing: Bool?, content: Bool?, reason: String) async throws {
        guard let rating = item.rating(timing: timing, content: content) else { return }
        defer { Task { await loadMuse() } }
        try await send("muse.item.rate", rating, reason: reason)
    }

    public func setMuseIntake(paused: Bool, reason: String) async throws {
        defer { Task { await loadMuse() } }
        try await send("muse.intake.set", MuseIntakeChange(paused: paused), reason: reason)
    }

    public func clearMuse(reason: String) async throws {
        defer { Task { await loadMuse() } }
        try await send("muse.data.clear", [String: String](), reason: reason)
    }

    public func loadSensitive(more: Bool = false) async {
        if more && sensitiveNext == nil { return }
        let before: JSONValue = more
            ? (sensitiveNext.flatMap { try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0)) } ?? .null)
            : .null
        do {
            let page = try await read("sensitive.interceptions.read", payload: ["before": before], as: SensitiveSnapshot.self)
            sensitiveCounts = page.counts
            sensitiveItems = more ? SensitiveRecords.appended(page, to: sensitiveItems) : page.items
            sensitiveNext = page.next
            sensitiveFailed = false
        } catch {
            sensitiveFailed = true
        }
    }

    public func clearSensitive(reason: String) async throws {
        defer { Task { await loadSensitive() } }
        try await send("sensitive.interceptions.clear", [String: String](), reason: reason)
    }
}
