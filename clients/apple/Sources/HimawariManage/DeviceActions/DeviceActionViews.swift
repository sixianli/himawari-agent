import HimawariCore
#if canImport(UIKit)
import UIKit
#endif
import HimawariDesign
import SwiftUI

struct ApprovalCard: View {
    let approval: PendingApproval
    let kicker: Bool
    let busy: Bool
    let open: () -> Void
    let respond: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 4) {
                    if kicker {
                        Text(L.text("approval.title"))
                            .hmType(DesignTokens.TypeScale.caption)
                            .foregroundStyle(Color.hmDanger)
                            .padding(.bottom, 2)
                    }
                    Text(approval.title)
                        .hmType(DesignTokens.TypeScale.navTitle)
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.leading)
                    if let body = approval.display?.bodyPreview {
                        Text(body)
                            .hmType(DesignTokens.TypeScale.secondary)
                            .foregroundStyle(Color.hmMuted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            HStack(spacing: 8) {
                Button(L.text("approval.open"), action: open)
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pill))
                Button(ApprovalWords.decline(approval)) { respond(false) }
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pill))
                Button(ApprovalWords.confirm(approval)) { respond(true) }
                    .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pill))
            }
            .disabled(busy)
            .opacity(busy ? 0.5 : 1)
        }
        .himawariCard(padding: EdgeInsets(top: 18, leading: 18, bottom: 18, trailing: 18))
    }
}

enum ApprovalWords {
    static func confirm(_ approval: PendingApproval) -> String {
        let label = approval.confirmLabel?.localized() ?? ""
        return label.isEmpty ? L.text("approval.confirm") : label
    }

    static func decline(_ approval: PendingApproval) -> String {
        let label = approval.declineLabel?.localized() ?? ""
        return label.isEmpty ? L.text("approval.deny") : label
    }
}

struct DeviceActionResultRow: View {
    let view: DeviceActionView

    var body: some View {
        let kind = DeviceActionResultKind(view)
        HStack(alignment: .top, spacing: 14) {
            icon(kind)
                .frame(width: DesignTokens.IconSize.listRow, height: DesignTokens.IconSize.listRow)
            VStack(alignment: .leading, spacing: 4) {
                Text(L.text(Self.headline(kind)))
                    .hmType(DesignTokens.TypeScale.navTitle)
                    .foregroundStyle(Color.hmText)
                Text(view.detail.localized())
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
                    .multilineTextAlignment(.leading)
                if kind == .notDone, let reason = view.reason, !reason.isEmpty {
                    Text(reason)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 16)
        .accessibilityElement(children: .combine)
    }

    static func headline(_ kind: DeviceActionResultKind) -> String {
        switch kind {
        case .done: "result.done"
        case .notDone: "result.notDone"
        case .checking: "result.checking"
        case .waiting: "result.waiting"
        case .other: "result.other"
        }
    }

    @ViewBuilder
    private func icon(_ kind: DeviceActionResultKind) -> some View {
        switch kind {
        case .done: Icon(.circleCheck, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmSuccess)
        case .notDone: Icon(.alertCircle, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmDanger)
        case .checking: ProgressView().tint(Color.hmMuted)
        case .waiting: Icon(.handStop, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmSun)
        case .other: Icon(.deviceMobile, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmMuted)
        }
    }
}

public struct TodayDeviceActionsCard: View {
    let model: DeviceActionsModel
    let openApproval: (PendingApproval) -> Void

    public init(model: DeviceActionsModel, openApproval: @escaping (PendingApproval) -> Void) {
        self.model = model
        self.openApproval = openApproval
    }

    public var body: some View {
        let results = model.recent.filter { $0.state != .waitingOwner }
        VStack(spacing: 12) {
            ForEach(model.pending) { approval in
                ApprovalCard(approval: approval, kicker: true, busy: model.busy.contains(approval.id), open: { openApproval(approval) }) { approved in
                    Task { await model.respond(approval, approved: approved) }
                }
            }
            if !results.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(results.enumerated()), id: \.element.id) { index, view in
                        DeviceActionResultRow(view: view)
                        if index < results.count - 1 { RowSeparator() }
                    }
                }
                .himawariCard(padding: EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
            }
        }
    }
}

struct NavigationHeader: View {
    let title: Text
    let back: () -> Void

    var body: some View {
        ZStack {
            title
                .hmType(DesignTokens.TypeScale.navTitle)
                .foregroundStyle(Color.hmText)
            HStack {
                GlassCircleButton(Text(L.text("common.back")), action: back) {
                    Icon(.chevronLeft, size: DesignTokens.IconSize.glassButton)
                }
                Spacer()
            }
        }
        .frame(minHeight: DesignTokens.Size.navBarHeight)
        .padding(.horizontal, 16)
    }
}

struct SegmentPicker: View {
    let titles: [String]
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(titles.enumerated()), id: \.offset) { index, title in
                Button {
                    withAnimation(.snappy) { selection = index }
                } label: {
                    Text(title)
                        .hmType(DesignTokens.TypeScale.secondary)
                        .fontWeight(selection == index ? .semibold : .regular)
                        .foregroundStyle(Color.hmText)
                        .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.minTapTarget)
                        .background(selection == index ? Color.hmSurface : Color.clear, in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(Color.hmFill, in: Capsule())
    }
}

public struct ApprovalsView: View {
    let model: DeviceActionsModel
    let close: () -> Void
    @State private var segment = 0
    @State private var opened: PendingApproval?

    public init(model: DeviceActionsModel, close: @escaping () -> Void) {
        self.model = model
        self.close = close
    }

    public var body: some View {
        ZStack {
            if let opened {
                ApprovalDetailView(model: model, approval: opened) { withAnimation(.snappy) { self.opened = nil } }
                    .transition(.move(edge: .trailing))
            } else {
                list.transition(.opacity)
            }
        }
        .himawariScreenBackground()
        .task {
            await model.refresh()
            await model.loadHandled()
        }
    }

    private var list: some View {
        VStack(spacing: 12) {
            NavigationHeader(title: Text(L.text("approval.title")), back: close)
            SegmentPicker(
                titles: [L.format("approval.segment.pending", model.pending.count), L.text("approval.segment.handled")],
                selection: $segment
            )
            .padding(.horizontal, 16)
            ScrollView {
                VStack(spacing: 12) {
                    if segment == 0 {
                        if model.pending.isEmpty {
                            EmptyStateView(Text(L.text("approval.empty")))
                                .frame(minHeight: DesignTokens.Size.emptyMinHeight)
                        }
                        ForEach(model.pending) { approval in
                            ApprovalCard(approval: approval, kicker: false, busy: model.busy.contains(approval.id), open: { open(approval) }) { approved in
                                Task { await model.respond(approval, approved: approved) }
                            }
                        }
                    } else {
                        handled
                    }
                    if let problem = model.problem {
                        Text(problem)
                            .hmType(DesignTokens.TypeScale.caption)
                            .foregroundStyle(Color.hmDanger)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 40)
            }
            .scrollIndicators(.hidden)
            .refreshable {
                await model.refresh()
                await model.loadHandled()
            }
        }
    }

    @ViewBuilder
    private var handled: some View {
        if model.handled.isEmpty {
            EmptyStateView(Text(L.text("approval.handled.empty")))
                .frame(minHeight: DesignTokens.Size.emptyMinHeight)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(model.handled.enumerated()), id: \.element.id) { index, approval in
                    Button { open(approval) } label: {
                        GroupedRow(Text(approval.title), icon: { EmptyView() }) { EmptyView() }
                            .overlay(alignment: .bottomLeading) {
                                Text(L.text("approval.status.\(approval.status)"))
                                    .hmType(DesignTokens.TypeScale.caption)
                                    .foregroundStyle(Color.hmMuted)
                                    .padding(.bottom, 4)
                            }
                    }
                    .buttonStyle(.plain)
                    if index < model.handled.count - 1 { RowSeparator() }
                }
            }
            .himawariCard(padding: EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
        }
    }

    private func open(_ approval: PendingApproval) {
        withAnimation(.snappy) { opened = approval }
    }
}

public struct ApprovalDetailView: View {
    let model: DeviceActionsModel
    let approval: PendingApproval
    let back: () -> Void

    public init(model: DeviceActionsModel, approval: PendingApproval, back: @escaping () -> Void) {
        self.model = model
        self.approval = approval
        self.back = back
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            NavigationHeader(title: Text(""), back: back)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(approval.title)
                        .hmType(DesignTokens.TypeScale.emptyTitle)
                        .foregroundStyle(Color.hmText)
                    if let body = approval.display?.bodyPreview {
                        Text(body)
                            .hmType(DesignTokens.TypeScale.body)
                            .foregroundStyle(Color.hmText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .himawariCard()
                    }
                    VStack(spacing: 0) {
                        reasonRow
                        if let origin = approval.display?.origin {
                            RowSeparator()
                            infoRow(L.text("approval.from"), origin.threadTitle.map { L.format("approval.from.thread", $0) } ?? L.text("approval.from.unnamed"))
                        }
                    }
                    .himawariCard(padding: EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)
            if approval.status == ApprovalStatus.pending.rawValue && model.pending.contains(where: { $0.id == approval.id }) {
                HStack(spacing: 12) {
                    Button(ApprovalWords.decline(approval)) { decide(false) }
                        .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pillBig))
                    Button(ApprovalWords.confirm(approval)) { decide(true) }
                        .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig))
                }
                .disabled(model.busy.contains(approval.id))
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
        .himawariScreenBackground()
    }

    private var reasonRow: some View {
        let because = approval.display?.askedBecause
        let text = because?.ruleText.map { L.format("approval.why.rule", $0) } ?? L.text("approval.why.noRule")
        return infoRow(L.text("approval.why"), text)
    }

    private func infoRow(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
            Text(detail)
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
        }
        .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.rowMinHeight, alignment: .leading)
    }

    private func decide(_ approved: Bool) {
        Task {
            await model.respond(approval, approved: approved)
            back()
        }
    }
}

public struct DeviceAbilitiesSection: View {
    let model: DeviceActionsModel
    @State private var primer: PermissionState?

    public init(model: DeviceActionsModel) {
        self.model = model
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if let policy = model.policy, !policy.actions.isEmpty {
                GroupedSection(Text(L.text("abilities.title"))) {
                    ForEach(Array(policy.actions.enumerated()), id: \.element.id) { index, entry in
                        ToggleRow(
                            Text(entry.shownTitle),
                            isOn: Binding(
                                get: { entry.allowed },
                                set: { allowed in Task { await model.setAllowed(entry.name, allowed: allowed) } }
                            )
                        ) { EmptyView() }
                        if index < policy.actions.count - 1 { RowSeparator() }
                    }
                }
            }
            if !model.permissions.isEmpty {
                GroupedSection(Text(L.text("abilities.system"))) {
                    ForEach(Array(model.permissions.enumerated()), id: \.element.id) { index, permission in
                        Button { primer = permission } label: {
                            GroupedRow(Text(permission.name), icon: { EmptyView() }) {
                                Text(L.text("permission.status.\(permission.status.rawValue)"))
                            }
                        }
                        .buttonStyle(.plain)
                        if index < model.permissions.count - 1 { RowSeparator() }
                    }
                }
            }
            if let problem = model.problem {
                Text(problem)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmDanger)
            }
        }
        .task { await model.refresh() }
        .sheet(item: $primer) { permission in
            PermissionPrimerView(permission: model.permissions.first { $0.id == permission.id } ?? permission) {
                Task { await model.request(permission.id) }
            } close: {
                primer = nil
            }
            .presentationDetents([.medium, .large])
        }
    }
}

public struct PermissionPrimerView: View {
    let permission: PermissionState
    let ask: () -> Void
    let close: () -> Void
    @Environment(\.openURL) private var openURL

    public init(permission: PermissionState, ask: @escaping () -> Void, close: @escaping () -> Void) {
        self.permission = permission
        self.ask = ask
        self.close = close
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(L.format("permission.title", permission.name))
                .hmType(DesignTokens.TypeScale.sheetTitle)
                .foregroundStyle(Color.hmText)
            Text(permission.purpose)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
            switch permission.status {
            case .authorized:
                Text(L.text("permission.allowed"))
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmSuccess)
            case .notDetermined:
                Text(L.text("permission.next"))
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
            case .denied, .unavailable:
                Text(L.format("permission.where", permission.settingsPath))
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
            }
            Spacer(minLength: 0)
            switch permission.status {
            case .notDetermined:
                Button(L.text("permission.continue"), action: ask)
                    .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig))
            case .denied:
                Button(L.text("permission.openSettings")) {
                    if let url = URL(string: SystemSettings.appURL) { openURL(url) }
                }
                .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig))
            default:
                Button(L.text("common.done"), action: close)
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pillBig))
            }
        }
        .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
        .padding(.top, DesignTokens.Size.sheetPaddingTop)
        .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        .himawariScreenBackground()
    }
}

enum SystemSettings {
    static var appURL: String {
        #if canImport(UIKit)
        UIApplication.openSettingsURLString
        #else
        "x-apple.systempreferences:"
        #endif
    }
}
