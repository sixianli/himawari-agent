import Foundation
import HimawariCore
import Observation

public enum LoadPhase: Equatable, Sendable {
    case loading
    case loaded
    case unsupported
    case failed
}

private func unsupported(_ error: Error) -> Bool {
    guard let error = error as? ManageGatewayError else { return false }
    switch error {
    case .unknownType, .notOnPhone: return true
    case .rejected(let status, _, _): return status == 501
    case .malformedResponse: return false
    }
}

@MainActor
@Observable
public final class SpokenExplanationStore {
    public private(set) var phase: LoadPhase = .loading
    public private(set) var explanation: SpokenExplanation?
    public private(set) var saving = false
    public var failedSave = false

    @ObservationIgnored private let messageId: String
    @ObservationIgnored private let read: (String) async throws -> SpokenExplanation
    @ObservationIgnored private let send: (String, SpokenRating?) async throws -> Void

    public init(gateway: ManageGateway, messageId: String) {
        self.messageId = messageId
        read = { id in
            try SpokenExplanation.decode(try await gateway.read(.v2, "decision.spoken.read", payload: ["messageId": .string(id)]))
        }
        send = { id, rating in
            _ = try await gateway.command(
                .v2,
                "decision.spoken.rate",
                payload: ["messageId": .string(id), "rating": rating.map { .string($0.rawValue) } ?? .null],
                options: ManageCommandOptions(confirmReason: M.whyTitle)
            )
        }
    }

    init(explanation: SpokenExplanation?, failing: Bool = false) {
        messageId = explanation?.messageId ?? "demo"
        let shown = explanation
        read = { _ in
            guard let shown else { throw ManageGatewayError.rejected(status: 404, code: nil) }
            return shown
        }
        send = { _, _ in
            if failing { throw ManageGatewayError.rejected(status: 409, code: nil) }
        }
        self.explanation = explanation
        phase = explanation == nil ? .failed : .loaded
    }

    public func load() async {
        do {
            explanation = try await read(messageId)
            phase = .loaded
        } catch {
            if explanation == nil { phase = unsupported(error) ? .unsupported : .failed }
        }
    }

    public func rate(_ rating: SpokenRating?) async {
        guard var current = explanation, current.rating != rating, !saving else { return }
        let before = current.rating
        current.rating = rating
        explanation = current
        saving = true
        defer { saving = false }
        do {
            try await send(messageId, rating)
        } catch {
            current.rating = before
            explanation = current
            failedSave = true
        }
    }
}

@MainActor
@Observable
public final class DecisionStatsStore {
    public private(set) var phase: LoadPhase = .loading
    public private(set) var stats: [StatsSpan: DecisionStats] = [:]

    @ObservationIgnored private let read: (StatsSpan) async throws -> DecisionStats

    public init(gateway: ManageGateway) {
        read = { span in
            try DecisionStats.decode(try await gateway.read(.v2, "decision.stats.read", payload: ["span": .string(span.rawValue)]))
        }
    }

    init(stats: [DecisionStats]?) {
        let shown = Dictionary(uniqueKeysWithValues: (stats ?? []).map { ($0.span, $0) })
        read = { span in
            guard let value = shown[span] else { throw ManageGatewayError.unknownType(.v2, "decision.stats.read") }
            return value
        }
        self.stats = shown
        phase = stats == nil ? .unsupported : .loaded
    }

    public func load(_ span: StatsSpan) async {
        do {
            stats[span] = try await read(span)
            phase = .loaded
        } catch {
            if unsupported(error) {
                phase = .unsupported
            } else if stats[span] == nil {
                phase = .failed
            }
        }
    }
}

@MainActor
@Observable
public final class OwnerFilesStore {
    public private(set) var phase: LoadPhase = .loading
    public private(set) var files: [OwnerFile] = []
    public private(set) var loadingMore = false
    public var filter: OwnerFileFilter = .all
    public var search = ""

    @ObservationIgnored private var nextCursor: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let read: (OwnerFileFilter, String, String?) async throws -> OwnerFilePage
    @ObservationIgnored private let fetch: (OwnerFile) async throws -> Data

    public init(gateway: ManageGateway, api: DeviceAPI) {
        read = { filter, search, cursor in
            let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
            let payload: JSONValue = [
                "kind": filter.payload.kind.map { .string($0) } ?? .null,
                "origin": filter.payload.origin.map { .string($0) } ?? .null,
                "before": cursor.map { .string($0) } ?? .null,
                "limit": .number(Double(OwnerFilePage.pageLimit)),
                "search": query.isEmpty ? .null : .string(query),
            ]
            return try OwnerFilePage.decode(try await gateway.read(.v2, "files.list.read", payload: payload))
        }
        fetch = { file in
            try await api.http.send(DeviceRequest(method: "GET", path: "files/content/\(file.fileId)"))
        }
    }

    init(files: [OwnerFile]?) {
        let shown = files
        read = { filter, search, _ in
            guard let shown else { throw ManageGatewayError.unknownType(.v2, "files.list.read") }
            let kept = shown.filter { file in
                switch filter {
                case .all: true
                case .kind(let kind): file.kind == kind
                case .uploaded: file.origin == .uploaded
                }
            }
            return OwnerFilePage(files: OwnerFileFilter.matching(kept, search: search), nextCursor: nil)
        }
        fetch = { _ in Data() }
        self.files = files ?? []
        phase = files == nil ? .unsupported : .loaded
    }

    public var hasMore: Bool { nextCursor != nil }

    public func load() async {
        generation += 1
        let mine = generation
        do {
            let page = try await read(filter, search, nil)
            guard mine == generation else { return }
            files = page.files
            nextCursor = page.nextCursor
            phase = .loaded
        } catch {
            guard mine == generation else { return }
            if unsupported(error) {
                phase = .unsupported
            } else if phase != .loaded {
                phase = .failed
            }
        }
    }

    public func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        let mine = generation
        loadingMore = true
        defer { loadingMore = false }
        guard let page = try? await read(filter, search, cursor), mine == generation else { return }
        files += page.files.filter { file in !files.contains { $0.fileId == file.fileId } }
        nextCursor = page.nextCursor
    }

    public func localCopy(_ file: OwnerFile) async throws -> URL {
        let data = try await fetch(file)
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("himawari-files", isDirectory: true)
            .appendingPathComponent(file.fileId.replacingOccurrences(of: "/", with: "_"), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(file.name.replacingOccurrences(of: "/", with: "_"))
        try data.write(to: url, options: .atomic)
        return url
    }
}
