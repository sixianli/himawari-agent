import Foundation
import HimawariCore
import HimawariManage
import Observation

public struct HomeActOutcome: Sendable, Equatable {
    public let message: String?
    public let undo: HomeFeedAction?

    public init(message: String?, undo: HomeFeedAction?) {
        self.message = message
        self.undo = undo
    }
}

public protocol HomeFeedSource: Sendable {
    func read(locale: HomeLocale) async throws -> HomeFeedSnapshot
    func act(_ item: HomeFeedItem, action: HomeFeedAction, revision: String) async throws -> HomeActOutcome
}

public struct HomeToast: Equatable, Identifiable {
    public let id = UUID()
    public let item: HomeFeedItem
    public let message: String
    public let undo: HomeFeedAction?
}

@MainActor
@Observable
public final class HomeFeedModel {
    public private(set) var snapshot: HomeFeedSnapshot?
    public private(set) var settled: Set<String> = []
    public private(set) var busy: Set<String> = []
    public private(set) var toast: HomeToast?
    public private(set) var failed = false

    @ObservationIgnored private let source: (any HomeFeedSource)?
    @ObservationIgnored private let locale: HomeLocale

    public init(source: (any HomeFeedSource)?, locale: HomeLocale = .matching(Locale.preferredLanguages)) {
        self.source = source
        self.locale = locale
    }

    init(snapshot: HomeFeedSnapshot, source: (any HomeFeedSource)? = nil, toast: (key: String, message: String, undo: Bool)? = nil) {
        self.source = source
        locale = .chinese
        self.snapshot = snapshot
        if let toast, let item = snapshot.items.first(where: { $0.key == toast.key }) {
            settled.insert(item.key)
            self.toast = HomeToast(item: item, message: toast.message, undo: toast.undo ? item.actions.first : nil)
        }
    }

    public var available: Bool { snapshot != nil }

    public var layout: HomeLayout? {
        snapshot.map { HomeLayout($0, settled: settled) }
    }

    public func refresh() async {
        guard let source else { return }
        do {
            let next = try await source.read(locale: locale)
            snapshot = next
            settled.formIntersection(Set(next.items.map(\.key)))
            failed = false
        } catch {
            failed = true
        }
    }

    public func canAct(_ item: HomeFeedItem, approvals: DeviceActionsModel?) -> Bool {
        if let id = item.approvalId, let approvals, approvals.pending.contains(where: { $0.id == id }) { return true }
        return source != nil
    }

    public func approval(for item: HomeFeedItem, in approvals: DeviceActionsModel?) -> PendingApproval? {
        guard let id = item.approvalId, let approvals else { return nil }
        return approvals.pending.first { $0.id == id }
    }

    public func decide(_ item: HomeFeedItem, action: HomeFeedAction, approvals: DeviceActionsModel?) async {
        guard !busy.contains(item.key) else { return }
        if let approvals, let approval = approval(for: item, in: approvals) {
            busy.insert(item.key)
            defer { busy.remove(item.key) }
            await approvals.respond(approval, approved: action.polarity == .positive)
            if !approvals.pending.contains(where: { $0.id == approval.id }) { settled.insert(item.key) }
            await refresh()
            return
        }
        guard let source, let revision = snapshot?.revision else { return }
        busy.insert(item.key)
        defer { busy.remove(item.key) }
        do {
            let outcome = try await source.act(item, action: action, revision: revision)
            settled.insert(item.key)
            if let message = outcome.message, !message.isEmpty {
                toast = HomeToast(item: item, message: message, undo: outcome.undo)
            }
        } catch {
            failed = true
        }
        await refresh()
    }

    public func undo(_ toast: HomeToast) async {
        guard let undo = toast.undo, let source, let revision = snapshot?.revision else {
            dismiss(toast)
            return
        }
        self.toast = nil
        do {
            _ = try await source.act(toast.item, action: undo, revision: revision)
            settled.remove(toast.item.key)
        } catch {
            failed = true
        }
        await refresh()
    }

    public func dismiss(_ toast: HomeToast) {
        if self.toast?.id == toast.id { self.toast = nil }
    }
}
