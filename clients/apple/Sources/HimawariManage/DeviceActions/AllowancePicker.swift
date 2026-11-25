import HimawariCore
import HimawariDesign
import SwiftUI

struct AllowancePicker: View {
    let approval: PendingApproval
    @Binding var selection: ApprovalAllowFor

    var body: some View {
        let limit = approval.allowanceLimit
        VStack(alignment: .leading, spacing: DesignTokens.Allowance.noteGap) {
            HStack(spacing: DesignTokens.Allowance.segmentGap) {
                ForEach(ApprovalAllowFor.allCases, id: \.self) { choice in
                    option(choice, on: (limit == nil ? selection : .once) == choice)
                }
            }
            .padding(DesignTokens.Allowance.segmentInset)
            .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.segment, style: .continuous))
            .opacity(limit == nil ? 1 : DesignTokens.Allowance.lockedOpacity)
            .disabled(limit != nil)
            if let limit {
                Text(Self.reason(limit))
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
            }
        }
    }

    private func option(_ choice: ApprovalAllowFor, on: Bool) -> some View {
        Button {
            selection = choice
        } label: {
            Text(Self.label(choice))
                .hmType(on ? DesignTokens.TypeScale.rowAction : DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmText)
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: DesignTokens.Allowance.segmentHeight)
                .background {
                    if on {
                        Capsule(style: .continuous)
                            .fill(Color.hmSurface)
                            .hmShadow(DesignTokens.Shadows.lift)
                    }
                }
                .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    static func label(_ choice: ApprovalAllowFor) -> String {
        switch choice {
        case .once: L.text("allowance.once")
        case .thisTask: L.text("allowance.thisTask")
        case .days: L.format("allowance.days", ApprovalAllowFor.defaultDays)
        case .always: L.text("allowance.always")
        }
    }

    static func reason(_ limit: ApprovalAllowanceLimit) -> String {
        switch limit {
        case .spending: L.text("allowance.locked.spending")
        case .credential: L.text("allowance.locked.credential")
        case .ownerPresence: L.text("allowance.locked.ownerPresence")
        case .asksEveryTime: L.text("allowance.locked.asksEveryTime")
        }
    }
}
