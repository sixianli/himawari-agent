import Foundation
import HimawariCore
import Observation

public enum PerceptionDeletionSegment: String, CaseIterable, Sendable {
    case episodes
    case days
    case kinds
}

public struct PerceptionDayGroup: Equatable, Identifiable, Sendable {
    public let day: String
    public let rows: [PerceptionDayRow]
    public var id: String { day }
}

public struct PerceptionDayCount: Equatable, Identifiable, Sendable {
    public let day: String
    public let total: Int
    public var id: String { day }
}

public enum PerceptionDeletionLoad: Equatable, Sendable {
    case loading
    case loaded
    case failed
}

@MainActor
@Observable
public final class PerceptionDeletionModel {
    public var segment: PerceptionDeletionSegment = .episodes
    public private(set) var today: String?
    public private(set) var groups: [PerceptionDayGroup] = []
    public private(set) var groupsLoad: PerceptionDeletionLoad = .loading
    public private(set) var days: [PerceptionDayCount] = []
    public private(set) var daysLoad: PerceptionDeletionLoad = .loading
    public private(set) var daysReached = 0
    public private(set) var working = false
    public var notice: String?

    @ObservationIgnored public let senses: SensesModel
    private var service: SensesService { senses.service }
    @ObservationIgnored let episodeDays = 2
    @ObservationIgnored let dayPage = 7
    @ObservationIgnored let pagesPerDay = 10

    public init(senses: SensesModel) {
        self.senses = senses
    }

    public var canDelete: Bool { senses.canDelete }

    public private(set) var lookBackDays = 7

    public var hasEarlierDays: Bool { daysReached < lookBackDays }

    public func load() async {
        await anchorToday()
        async let episodes: Void = loadEpisodes()
        async let counts: Void = loadDays(reset: true)
        _ = await (episodes, counts)
    }

    private func anchorToday() async {
        if let status = try? await service.status() {
            today = status.day
            lookBackDays = max(dayPage, status.retention.map(\.days).max() ?? dayPage)
        }
        if today == nil { today = PerceptionTime.day(Date(), timeZone: .current) }
    }

    public func loadEpisodes() async {
        guard let today else { return }
        if groups.isEmpty { groupsLoad = .loading }
        do {
            var loaded: [PerceptionDayGroup] = []
            for offset in 0..<episodeDays {
                guard let day = PerceptionTime.shift(day: today, by: -offset) else { continue }
                loaded.append(PerceptionDayGroup(day: day, rows: try await allRows(day)))
            }
            groups = loaded
            groupsLoad = .loaded
        } catch {
            groupsLoad = .failed
        }
    }

    private func allRows(_ day: String) async throws -> [PerceptionDayRow] {
        var rows: [PerceptionDayRow] = []
        var cursor: String?
        for _ in 0..<pagesPerDay {
            let page = try await service.dayPage(day, cursor: cursor)
            rows += page.rows
            guard let next = page.nextCursor else { break }
            cursor = next
        }
        return rows
    }

    public func loadDays(reset: Bool = false) async {
        guard let today else { return }
        if reset {
            daysReached = 0
            if days.isEmpty { daysLoad = .loading }
        }
        let start = daysReached
        let end = min(start + dayPage, lookBackDays)
        guard start < end else { return }
        do {
            var found: [PerceptionDayCount] = reset ? [] : days
            for offset in start..<end {
                guard let day = PerceptionTime.shift(day: today, by: -offset) else { continue }
                let page = try await service.dayPage(day, cursor: nil)
                if page.total > 0 { found.append(PerceptionDayCount(day: day, total: page.total)) }
            }
            days = found
            daysReached = end
            daysLoad = .loaded
        } catch {
            if reset { daysLoad = .failed }
        }
    }

    public func delete(_ target: PerceptionDeletionTarget, reason: String) async -> Bool {
        guard canDelete, !working else { return false }
        working = true
        defer { working = false }
        do {
            let result = try await service.delete(target, reason: reason)
            notice = L.format("detail.deleted", result.removed)
            await refreshAfterDeletion()
            return true
        } catch SensesGatewayError.confirmationCancelled {
            return false
        } catch {
            notice = L.text("detail.failed")
            return false
        }
    }

    private func refreshAfterDeletion() async {
        async let episodes: Void = loadEpisodes()
        async let counts: Void = reloadDays()
        _ = await (episodes, counts)
    }

    private func reloadDays() async {
        let reached = max(daysReached, dayPage)
        await loadDays(reset: true)
        while daysReached < reached, hasEarlierDays { await loadDays() }
    }

    public func episode(_ episodeId: String) async throws -> PerceptionEpisodeSnapshot {
        var snapshot = try await service.episode(episodeId, cursor: nil)
        var records = snapshot.records
        var cursor = snapshot.nextCursor
        var pages = 1
        while let next = cursor, pages < pagesPerDay {
            snapshot = try await service.episode(episodeId, cursor: next)
            records += snapshot.records
            cursor = snapshot.nextCursor
            pages += 1
        }
        return PerceptionEpisodeSnapshot(episode: snapshot.episode, records: records, nextCursor: cursor)
    }
}
