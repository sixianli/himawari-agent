#if os(macOS)
import HimawariCore
import HimawariDesign
import LocalAuthentication
import SwiftUI

enum OwnerPresence {
    static func confirm(reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        let policy: LAPolicy = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
            ? .deviceOwnerAuthenticationWithBiometrics
            : .deviceOwnerAuthentication
        return (try? await context.evaluatePolicy(policy, localizedReason: reason)) ?? false
    }
}

struct ChecklistView: View {
    let list: ChangeList
    let decline: () -> Void
    let approve: () -> Void
    @State private var expanded: Bool
    @State private var failed = false
    @State private var asking = false

    init(list: ChangeList, expanded: Bool = false, decline: @escaping () -> Void, approve: @escaping () -> Void) {
        self.list = list
        self.decline = decline
        self.approve = approve
        _expanded = State(initialValue: expanded)
    }

    var body: some View {
        GlassPanel(radius: DesignTokens.Mac.checklistRadius) {
            VStack(alignment: .leading, spacing: DesignTokens.Mac.checklistGap) {
                Text(list.title)
                    .hmType(DesignTokens.TypeScale.macChecklistTitle)
                    .foregroundStyle(Color.hmText)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 0) {
                    ForEach(list.rows) { row in
                        HStack(spacing: DesignTokens.Mac.inputGap) {
                            if let icon = row.icon.flatMap(IconName.init(rawValue:)) {
                                Icon(icon, size: DesignTokens.Mac.checklistIcon).foregroundStyle(Color.hmMuted)
                            }
                            Text(row.text)
                                .hmType(DesignTokens.TypeScale.macRow)
                                .foregroundStyle(Color.hmText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if let note = row.note {
                                Text(note)
                                    .hmType(DesignTokens.TypeScale.macSetting)
                                    .foregroundStyle(Color.hmMuted)
                            }
                        }
                        .padding(.vertical, DesignTokens.Mac.checklistRowPadding)
                        Divider().overlay(Color.hmSeparator)
                    }
                    if !list.items.isEmpty {
                        Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                            HStack(spacing: DesignTokens.Mac.statusBadgeGap) {
                                Text(L.text("checklist.oneByOne")).hmType(DesignTokens.TypeScale.macRow)
                                Icon(.chevronRight, size: DesignTokens.Mac.chipIcon)
                                    .rotationEffect(.degrees(expanded ? 90 : 0))
                            }
                            .foregroundStyle(Color.hmSun)
                            .padding(.vertical, DesignTokens.Mac.checklistRowPadding)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.pressable)
                        if expanded {
                            ScrollView {
                                VStack(alignment: .leading, spacing: DesignTokens.Mac.statusBadgeGap) {
                                    ForEach(Array(list.items.enumerated()), id: \.offset) { _, item in
                                        Text(item)
                                            .hmType(DesignTokens.TypeScale.macSetting)
                                            .foregroundStyle(Color.hmText)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                            }
                            .frame(maxHeight: DesignTokens.Mac.inputAnswerMaxHeight)
                        }
                    }
                }
                if failed {
                    Text(L.text("checklist.failed"))
                        .hmType(DesignTokens.TypeScale.macSmall)
                        .foregroundStyle(Color.hmDanger)
                }
                HStack(spacing: DesignTokens.Mac.buttonGap) {
                    Spacer()
                    Button(L.text("checklist.notNow"), action: decline)
                        .buttonStyle(MacButtonStyle(role: .secondary))
                    Button {
                        guard !asking else { return }
                        asking = true
                        Task {
                            let ok = await OwnerPresence.confirm(reason: L.text("checklist.touchIdReason"))
                            asking = false
                            failed = !ok
                            if ok { approve() }
                        }
                    } label: {
                        HStack(spacing: DesignTokens.Mac.buttonGap) {
                            Icon(.fingerprint, size: DesignTokens.Mac.settingsIcon)
                            Text(L.text("checklist.approve"))
                        }
                    }
                    .buttonStyle(MacButtonStyle(role: .primary))
                    .disabled(asking)
                }
            }
            .padding(DesignTokens.Mac.checklistPadding)
        }
        .frame(width: DesignTokens.Mac.checklistWidth)
    }
}
#endif
