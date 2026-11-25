import HimawariCore
#if canImport(UIKit)
import UIKit
#endif
import HimawariDesign
import SwiftUI

struct ApprovalCard: View {
    let approval: PendingApproval
    let allowanceDays: Int?
    let busy: Bool
    let open: () -> Void
    let respond: (Bool, ApprovalAllowFor) -> Void
    @State private var allowFor: ApprovalAllowFor = .once

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
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
                Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                    .foregroundStyle(Color.hmMuted)
            }
            AllowancePicker(approval: approval, days: allowanceDays, selection: $allowFor)
            HStack(spacing: 8) {
                Button(ApprovalWords.decline(approval)) { respond(false, .once) }
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pill))
                Button(ApprovalWords.confirm(approval)) { respond(true, allowFor) }
                    .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pill))
            }
            .disabled(busy)
            .opacity(busy ? 0.5 : 1)
        }
        .himawariCard(padding: EdgeInsets(top: 18, leading: 18, bottom: 18, trailing: 18))
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .accessibilityAction(named: Text(L.text("approval.open")), open)
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

public struct ApprovalsView: View {
    let model: DeviceActionsModel
    let openThread: ((String) -> Void)?
    let close: () -> Void
    @State private var segment = 0
    @State private var opened: PendingApproval?

    public init(model: DeviceActionsModel, openThread: ((String) -> Void)? = nil, close: @escaping () -> Void) {
        self.model = model
        self.openThread = openThread
        self.close = close
    }

    public var body: some View {
        ZStack {
            if let opened {
                ApprovalDetailView(model: model, approval: opened, openThread: openThread) { withAnimation(.snappy) { self.opened = nil } }
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
                selection: $segment,
                options: [(0, L.format("approval.segment.pending", model.pending.count)), (1, L.text("approval.segment.handled"))]
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
                            ApprovalCard(approval: approval, allowanceDays: model.allowanceDays, busy: model.busy.contains(approval.id), open: { open(approval) }) { approved, allowFor in
                                Task { await model.respond(approval, approved: approved, allowFor: allowFor) }
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
    let openThread: ((String) -> Void)?
    let back: () -> Void
    @State private var allowFor: ApprovalAllowFor = .once

    public init(model: DeviceActionsModel, approval: PendingApproval, openThread: ((String) -> Void)? = nil, back: @escaping () -> Void) {
        self.model = model
        self.approval = approval
        self.openThread = openThread
        self.back = back
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            NavigationHeader(title: Text(""), back: back)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(approval.title)
                        .hmType(DesignTokens.TypeScale.emptyTitle)
                        .foregroundStyle(Color.hmText)
                        .padding(.horizontal, 4)
                    content
                    VStack(spacing: 0) {
                        reasonRow
                        if let origin = approval.display?.origin {
                            RowSeparator()
                            originRow(origin)
                        }
                    }
                    .himawariCard(padding: EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
                }
                .padding(.horizontal, 16)
            }
            .scrollIndicators(.hidden)
            if approval.status == ApprovalStatus.pending.rawValue && model.pending.contains(where: { $0.id == approval.id }) {
                VStack(spacing: DesignTokens.Allowance.actionsGap) {
                    AllowancePicker(approval: approval, days: model.allowanceDays, selection: $allowFor)
                    HStack(spacing: 8) {
                        Button(ApprovalWords.decline(approval)) { decide(false) }
                            .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pillBig))
                        Button(ApprovalWords.confirm(approval)) { decide(true) }
                            .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig))
                    }
                }
                .disabled(model.busy.contains(approval.id))
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
            }
        }
        .himawariScreenBackground()
    }

    @ViewBuilder
    private var content: some View {
        let source = model.source(of: approval)
        let body = approval.display?.bodyPreview
        if source != nil || body != nil {
            VStack(alignment: .leading, spacing: 10) {
                if let source {
                    Text(source)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                }
                if let body {
                    Text(body)
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .himawariCard(padding: EdgeInsets(top: 18, leading: 20, bottom: 18, trailing: 20))
        }
    }

    private var reasonRow: some View {
        let because = approval.display?.askedBecause
        let text = because?.ruleText.map { L.format("approval.why.rule", $0) } ?? L.text("approval.why.noRule")
        return infoRow(L.text("approval.why"), text, chevron: false)
    }

    @ViewBuilder
    private func originRow(_ origin: PendingApproval.Origin) -> some View {
        let text = origin.threadTitle.map { L.format("approval.from.thread", $0) } ?? L.text("approval.from.unnamed")
        if let openThread {
            Button { openThread(origin.threadId) } label: {
                infoRow(L.text("approval.from"), text, chevron: true)
            }
            .buttonStyle(.plain)
        } else {
            infoRow(L.text("approval.from"), text, chevron: false)
        }
    }

    private func infoRow(_ title: String, _ detail: String, chevron: Bool) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                Text(detail)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if chevron {
                Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
        .contentShape(Rectangle())
    }

    private func decide(_ approved: Bool) {
        Task {
            await model.respond(approval, approved: approved, allowFor: approved ? allowFor : .once)
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
        VStack(alignment: .leading, spacing: 22) {
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
            GlassCircleButton(Text(L.text("common.close")), action: close) {
                Icon(.x, size: DesignTokens.IconSize.glassButton)
            }
            Text(L.format("permission.title", permission.name))
                .hmType(DesignTokens.TypeScale.emptyTitle)
                .foregroundStyle(Color.hmText)
                .padding(.top, 6)
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
