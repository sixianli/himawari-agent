import HimawariCore
import HimawariDesign
import SwiftUI

struct AllowancePicker: View {
    let approval: PendingApproval
    let days: Int?
    @Binding var selection: ApprovalAllowFor

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if let limit = approval.allowanceLimit {
            Text(Self.reason(limit))
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if typeSize.isAccessibilitySize {
            Picker(L.text("allowance.title"), selection: $selection) { options }
                .pickerStyle(.menu)
                .tint(Color.hmText)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Picker(L.text("allowance.title"), selection: $selection) { options }
                .pickerStyle(.segmented)
                .labelsHidden()
        }
    }

    private var options: some View {
        ForEach(ApprovalAllowFor.allCases.filter { $0 != .days || days != nil }, id: \.self) { choice in
            Text(Self.label(choice, days: days)).tag(choice)
        }
    }

    static func label(_ choice: ApprovalAllowFor, days: Int?) -> String {
        switch choice {
        case .once: L.text("allowance.once")
        case .thisTask: L.text("allowance.thisTask")
        case .days: L.format("allowance.days", days ?? 0)
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
