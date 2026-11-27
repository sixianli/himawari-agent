import Foundation
import HimawariCore
import HimawariDesign
import Observation

public struct PermissionState: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let purpose: String
    public let settingsPath: String
    public let status: DevicePermissionStatus
}

@MainActor
@Observable
public final class DeviceActionsModel {
    public internal(set) var pending: [PendingApproval] = []
    public internal(set) var handled: [PendingApproval] = []
    public internal(set) var recent: [DeviceActionView] = []
    public internal(set) var policy: DevicePolicyView?
    public internal(set) var permissions: [PermissionState] = []
    public internal(set) var sourceNames: [String: String] = [:]
    public internal(set) var permissionOfAction: [String: String] = [:]
    public internal(set) var approvalsAvailable = true
    public internal(set) var allowanceDays: Int?
    public internal(set) var busy: Set<String> = []
    public internal(set) var problem: String?

    @ObservationIgnored private let api: DeviceAPI?
    @ObservationIgnored private let executor: DeviceActionExecutor?
    @ObservationIgnored private let confirm: DeviceKeySigner?
    @ObservationIgnored private let store: LocalStore?
    @ObservationIgnored private var sources: [String: DevicePermission] = [:]
    @ObservationIgnored private var running: Task<Void, Never>?

    static let recentWindow: TimeInterval = 24 * 3600

    public init(api: DeviceAPI, executor: DeviceActionExecutor, confirm: DeviceKeySigner, store: LocalStore) {
        self.api = api
        self.executor = executor
        self.confirm = confirm
        self.store = store
    }

    init(pending: [PendingApproval], handled: [PendingApproval], recent: [DeviceActionView], policy: DevicePolicyView?, permissions: [PermissionState], sourceNames: [String: String] = [:], allowanceDays: Int? = nil) {
        api = nil
        executor = nil
        confirm = nil
        store = nil
        self.pending = pending
        self.handled = handled
        self.recent = recent
        self.policy = policy
        self.permissions = permissions
        self.sourceNames = sourceNames
        self.allowanceDays = allowanceDays
    }

    public var waitingCount: Int { pending.count }

    public func source(of approval: PendingApproval) -> String? {
        sourceNames[approval.intent.operation]
    }

    public func deviceActionsChanged() {
        guard let executor else { return }
        running?.cancel()
        running = Task { [weak self] in
            await executor.run()
            await self?.refresh()
        }
    }

    public func refresh() async {
        guard let api else { return }
        await refreshPermissions()
        do {
            pending = try await api.approvals(status: .pending)
            approvalsAvailable = true
        } catch DeviceAPIError.server(let status, _, _, _) where status == 404 || status == 503 {
            approvalsAvailable = false
        } catch {}
        if let views = try? await api.actionViews(finishedSince: api.http.correctedNow.addingTimeInterval(-Self.recentWindow)) {
            recent = views.sorted { $0.updatedAt > $1.updatedAt }
        }
        if let policy = try? await api.actionPolicy() { self.policy = policy }
        allowanceDays = try? await api.allowanceDays()
    }

    public func loadHandled() async {
        guard let api, approvalsAvailable else { return }
        var all: [PendingApproval] = []
        for status in [ApprovalStatus.approved, .denied, .expired] {
            all += (try? await api.approvals(status: status)) ?? []
        }
        handled = all.sorted { ($0.decidedAt ?? $0.requestedAt) > ($1.decidedAt ?? $1.requestedAt) }
    }

    public func refreshPermissions() async {
        guard let executor else { return }
        var states: [PermissionState] = []
        for permission in await executor.permissions() {
            sources[permission.id] = permission
            states.append(PermissionState(
                id: permission.id,
                name: permission.name.localized(),
                purpose: permission.purpose.localized(),
                settingsPath: permission.settingsPath.localized(),
                status: await permission.status()
            ))
        }
        permissions = states
        let names = Dictionary(uniqueKeysWithValues: states.map { ($0.id, $0.name) })
        let ids = await executor.permissionIds()
        permissionOfAction = ids
        sourceNames = ids.compactMapValues { names[$0] }
    }

    public func request(_ permissionId: String) async {
        guard let permission = sources[permissionId] else { return }
        _ = await permission.request()
        await refreshPermissions()
        deviceActionsChanged()
    }

    public func respond(_ approval: PendingApproval, approved: Bool, allowFor: ApprovalAllowFor = .once) async {
        guard let api, !busy.contains(approval.id) else { return }
        busy.insert(approval.id)
        defer { busy.remove(approval.id) }
        problem = nil
        do {
            let reply = try await api.respond(to: approval, approved: approved, allowFor: allowFor, days: allowanceDays, confirm: confirm, reason: approval.title)
            if approved && approval.recentAuthenticationRequired { Haptics.shared.report(.faceIDSucceeded) }
            if reply == .changed { problem = DeviceActionsText.changed }
            if reply == .allowanceNotSaved { problem = DeviceActionsText.allowanceNotSaved }
            pending.removeAll { $0.id == approval.id }
        } catch {
            if approved && approval.recentAuthenticationRequired { Haptics.shared.report(.faceIDFailed) }
            problem = DeviceActionsText.notSent
        }
        await refresh()
    }

    public func undo(_ view: DeviceActionView) async {
        guard let api, view.undo == .available, !busy.contains(view.id) else { return }
        busy.insert(view.id)
        defer { busy.remove(view.id) }
        problem = nil
        do {
            let reply = try await api.undoAction(id: view.id, confirm: confirm, reason: view.detail.localized())
            if case .recorded = reply {} else { problem = DeviceActionsText.cannotUndo }
        } catch {
            problem = DeviceActionsText.notSent
        }
        await refresh()
    }

    public func setAllowed(_ name: String, allowed: Bool) async {
        guard let api, let confirm, let policy else { return }
        var blocked = policy.blocked
        if allowed { blocked.remove(name) } else { blocked.insert(name) }
        problem = nil
        do {
            switch try await api.changeActionPolicy(expectedRevision: policy.revision, blocked: Array(blocked), confirm: confirm, reason: DeviceActionsText.policyReason) {
            case let .written(updated):
                self.policy = updated
                Haptics.shared.report(.faceIDSucceeded)
            case let .conflict(latest):
                self.policy = latest
                problem = DeviceActionsText.changed
            case .ownerPresenceRequired:
                problem = DeviceActionsText.needsFace
            }
        } catch {
            Haptics.shared.report(.faceIDFailed)
            problem = DeviceActionsText.notSent
        }
        deviceActionsChanged()
    }
}
