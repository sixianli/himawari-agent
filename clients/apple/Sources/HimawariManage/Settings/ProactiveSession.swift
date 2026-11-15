import Foundation
import HimawariCore
import Observation

public enum ProactiveInsightAction: String, Sendable {
    case done
    case mute
    case reopen
    case rate
}

@MainActor
@Observable
public final class ProactiveSession {
    public enum Load: Equatable {
        case loading
        case loaded
        case failed
    }

    public private(set) var overview: ProactiveOverview?
    public private(set) var sources: [ProactiveSource]?
    public private(set) var overviewLoad: Load = .loading
    public private(set) var sourcesLoad: Load = .loading

    @ObservationIgnored private let gateway: ManageGateway
    @ObservationIgnored private var overviewGeneration = 0

    init(gateway: ManageGateway) {
        self.gateway = gateway
    }

    public func reloadOverview() async {
        overviewGeneration += 1
        let generation = overviewGeneration
        do {
            let data = try await gateway.read(.v2, "proactive.overview.read")
            let decoded = try JSONDecoder().decode(Snapshot<ProactiveOverview>.self, from: data).payload
            guard generation == overviewGeneration else { return }
            overview = decoded
            overviewLoad = .loaded
        } catch {
            overviewLoad = overview == nil ? .failed : .loaded
        }
    }

    public func reloadSources() async {
        do {
            let data = try await gateway.read(.v2, "proactive.sources.read")
            sources = try JSONDecoder().decode(Snapshot<ProactiveSourceList>.self, from: data).payload.sources
            sourcesLoad = .loaded
        } catch {
            sourcesLoad = sources == nil ? .failed : .loaded
        }
    }

    public func setEnabled(_ enabled: Bool, reason: String) async throws {
        guard let overview else { throw ManageGatewayError.malformedResponse }
        defer { Task { await reloadOverview() } }
        if enabled {
            _ = try await gateway.command(
                .v2,
                "proactive.settings.set",
                payload: Self.settingsPayload(overview, enabled: true),
                options: ManageCommandOptions(risk: "medium", confirmReason: reason)
            )
        } else {
            _ = try await gateway.command(
                .v2,
                "proactive.pause",
                payload: [:],
                options: ManageCommandOptions(risk: "medium", confirmReason: reason)
            )
        }
    }

    public func respond(_ insight: ProactiveInsight, _ action: ProactiveInsightAction, rating: ProactiveRating? = nil, reason: String) async throws {
        defer { Task { await reloadOverview() } }
        _ = try await gateway.command(
            .v2,
            "proactive.insight.respond",
            payload: [
                "insightId": .string(insight.id),
                "action": .string(action.rawValue),
                "rating": rating.map { .string($0.rawValue) } ?? .null,
            ],
            options: ManageCommandOptions(risk: "medium", confirmReason: reason)
        )
    }

    public func rate(_ decision: ProactiveDecision, _ rating: ProactiveRating?, reason: String) async throws {
        defer { Task { await reloadOverview() } }
        _ = try await gateway.command(
            .v2,
            "proactive.decision.rate",
            payload: [
                "decisionId": .string(decision.id),
                "rating": rating.map { .string($0.rawValue) } ?? .null,
            ],
            options: ManageCommandOptions(risk: "medium", confirmReason: reason)
        )
    }

    public func restore(_ backoff: ProactiveBackoff, reason: String) async throws {
        defer { Task { await reloadOverview() } }
        _ = try await gateway.command(
            .v2,
            "proactive.backoff.restore",
            payload: ["classKey": .string(backoff.classKey)],
            options: ManageCommandOptions(risk: "medium", confirmReason: reason)
        )
    }

    public func change(_ source: ProactiveSource, enabled: Bool, perDay: Int, perCheck: Int, reason: String) async throws {
        defer { Task { await reloadSources() } }
        let onlySwitchedOff = !enabled && source.enabled && perDay == source.perDay.limit && perCheck == source.perCheck.limit
        if onlySwitchedOff {
            _ = try await gateway.command(
                .v2,
                "proactive.source.switch_off",
                payload: ["source": .string(source.source)],
                options: ManageCommandOptions(risk: "medium", confirmReason: reason)
            )
            return
        }
        _ = try await gateway.command(
            .v2,
            "proactive.source.settings.set",
            payload: Self.sourcePayload(source, enabled: enabled, perDay: perDay, perCheck: perCheck),
            options: ManageCommandOptions(risk: "medium", confirmReason: reason)
        )
    }

    static func settingsPayload(_ overview: ProactiveOverview, enabled: Bool) -> JSONValue {
        var periods: [JSONValue] = []
        for period in overview.quietHours {
            var days: [JSONValue] = []
            for day in period.days { days.append(.number(Double(day))) }
            periods.append(.object(["days": .array(days), "start": .string(period.start), "end": .string(period.end)]))
        }
        var senders: [JSONValue] = []
        for sender in overview.importantSenders { senders.append(.string(sender)) }
        return [
            "enabled": .bool(enabled),
            "quietHours": .array(periods),
            "importantSenders": .array(senders),
        ]
    }

    static func sourcePayload(_ source: ProactiveSource, enabled: Bool, perDay: Int, perCheck: Int) -> JSONValue {
        [
            "source": .string(source.source),
            "enabled": .bool(enabled),
            "perDay": .number(Double(perDay)),
            "perCheck": .number(Double(perCheck)),
        ]
    }
}
