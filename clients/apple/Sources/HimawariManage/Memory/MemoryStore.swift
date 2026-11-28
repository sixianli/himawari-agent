import Foundation
import Observation

@MainActor
@Observable
public final class MemoryStore {
    public enum Phase: Equatable {
        case loading
        case loaded
        case failed(String?)
    }

    public private(set) var phase: Phase = .loading
    public private(set) var overview: MemoryOverview?
    public private(set) var rules: [RuleSummary] = []
    public private(set) var allowances: [OwnerAllowance] = []
    public private(set) var allowanceDays: Int?

    @ObservationIgnored private let gateway: ManageGateway

    public init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    public func load() async {
        do {
            async let overviewData = gateway.read(.v2, "memory.overview.read")
            async let rulesData = gateway.read(.v2, "memory.rules.read")
            let decoder = JSONDecoder()
            overview = try decoder.decode(Snapshot<MemoryOverview>.self, from: try await overviewData).payload
            let book = try decoder.decode(Snapshot<RuleBook>.self, from: try await rulesData).payload
            rules = book.rules
            allowances = book.allowances ?? []
            allowanceDays = book.allowanceDays
            phase = .loaded
        } catch let ManageGatewayError.rejected(_, code, _) {
            phase = .failed(code)
        } catch {
            phase = .failed(nil)
        }
    }

    public func search(_ query: String) async throws -> [MemorySearchHit] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        let data = try await gateway.read(.v2, "memory.search.read", payload: ["query": .string(trimmed)])
        return try JSONDecoder().decode(Snapshot<MemorySearchSnapshot>.self, from: data).payload.results
    }

    public func memory(_ id: String) -> MemoryItem? {
        overview?.memories.first { $0.memoryId == id && $0.status == "active" }
    }

    public func rule(_ id: String?) -> RuleSummary? {
        guard let id else { return nil }
        return rules.first { $0.ruleId == id }
    }

    public func groups(categoryLabel: (String) -> String) -> [MemoryGroup] {
        MemoryOrganizer.groups(overview?.memories ?? [], categoryLabel: categoryLabel)
    }

    public func provenance(_ item: MemoryItem) -> MemoryProvenance {
        MemoryOrganizer.provenance(item, imports: overview?.imports ?? [])
    }

    public func correct(_ item: MemoryItem, text: String, reason: String) async throws {
        let contentRef = try await gateway.uploadText(text, dataClassification: item.dataClassification ?? "private")
        _ = try await gateway.command(
            .v2,
            "memory.mutate",
            payload: [
                "action": "correct",
                "memoryId": .string(item.memoryId),
                "expectedRevision": .number(Double(item.revision)),
                "contentRef": .string(contentRef),
                "historyId": nil,
            ],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await load()
    }

    public var trashed: [MemoryItem] {
        (overview?.memories ?? []).filter { $0.status == "trashed" }
    }

    public static func previousVersions(of item: MemoryItem) -> [MemoryItem.History] {
        guard item.status == "active" else { return [] }
        var seen: Set<String> = [item.text]
        return item.history
            .filter { $0.kind != "reaffirmed" }
            .sorted { $0.at > $1.at }
            .filter { seen.insert($0.text).inserted }
    }

    public static func trashDeadline(of item: MemoryItem) -> Date? {
        guard let trashedAt = Timestamp.parse(item.updatedAt ?? item.recordedAt) else { return nil }
        return trashedAt.addingTimeInterval(TimeInterval(ClientCapabilities.memoryTrashDays) * 86_400)
    }

    public func restoreVersion(_ item: MemoryItem, historyId: Int, reason: String) async throws {
        try await mutate(item, action: "restore_version", historyId: historyId, reason: reason)
    }

    public func recover(_ item: MemoryItem, reason: String) async throws {
        try await mutate(item, action: "recover", historyId: nil, reason: reason)
    }

    private func mutate(_ item: MemoryItem, action: String, historyId: Int?, reason: String) async throws {
        _ = try await gateway.command(
            .v2,
            "memory.mutate",
            payload: [
                "action": .string(action),
                "memoryId": .string(item.memoryId),
                "expectedRevision": .number(Double(item.revision)),
                "contentRef": nil,
                "historyId": historyId.map { JSONValue.number(Double($0)) } ?? .null,
            ],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await load()
    }

    public func delete(_ item: MemoryItem, reason: String) async throws {
        _ = try await gateway.command(
            .v2,
            "memory.mutate",
            payload: [
                "action": "delete",
                "memoryId": .string(item.memoryId),
                "expectedRevision": .number(Double(item.revision)),
                "contentRef": nil,
                "historyId": nil,
            ],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await load()
    }

    public func respond(_ rule: RuleSummary, action: String, reason: String) async throws {
        _ = try await gateway.command(
            .v2,
            "memory.rule.respond",
            payload: ["target": .string(rule.ruleId), "action": .string(action)],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await load()
    }

    public func revoke(_ allowance: OwnerAllowance, reason: String) async throws {
        guard let index = allowances.firstIndex(of: allowance) else { return }
        allowances.remove(at: index)
        do {
            _ = try await gateway.command(
                .v2,
                "approval.allowance.revoke",
                payload: ["allowanceId": .string(allowance.allowanceId)],
                options: ManageCommandOptions(confirmReason: reason)
            )
        } catch {
            if !allowances.contains(allowance) { allowances.insert(allowance, at: min(index, allowances.count)) }
            throw error
        }
    }

    public func setAllowanceDays(_ days: Int, reason: String) async throws {
        guard ClientCapabilities.allowanceDays.contains(days) else { return }
        _ = try await gateway.command(
            .v2,
            "approval.allowance.days.set",
            payload: ["days": .number(Double(days))],
            options: ManageCommandOptions(risk: "medium", confirmReason: reason)
        )
        allowanceDays = days
    }

    public func summary(categoryLabel: (String) -> String) -> MemorySummary? {
        guard phase == .loaded else { return nil }
        let shown = groups(categoryLabel: categoryLabel)
        return MemorySummary(memories: shown.reduce(0) { $0 + $1.items.count })
    }

    public func setCapturePaused(_ paused: Bool, reason: String) async throws {
        _ = try await gateway.command(
            .v2,
            "memory.settings.set",
            payload: ["capturePaused": .bool(paused)],
            options: ManageCommandOptions(confirmReason: reason)
        )
        await load()
    }

    public func basis(_ item: MemoryItem) -> MemoryBasis {
        MemoryOrganizer.basis(item, imports: overview?.imports ?? [])
    }
}
