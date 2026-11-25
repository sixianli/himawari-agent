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
            phase = .loaded
        } catch let ManageGatewayError.rejected(_, code, _) {
            phase = .failed(code)
        } catch {
            phase = .failed(nil)
        }
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

    public func summary(categoryLabel: (String) -> String) -> MemorySummary? {
        guard phase == .loaded else { return nil }
        let shown = groups(categoryLabel: categoryLabel)
        return MemorySummary(memories: shown.reduce(0) { $0 + $1.items.count }, topics: shown.count, rules: rules.count)
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
