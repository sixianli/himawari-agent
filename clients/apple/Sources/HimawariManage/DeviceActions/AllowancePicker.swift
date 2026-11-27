import HimawariCore
import HimawariDesign
import SwiftUI

struct AllowancePicker: View {
    let approval: PendingApproval
    let days: Int?
    @Binding var selection: ApprovalAllowFor

    var body: some View {
        if let limit = approval.allowanceLimit {
            Text(Self.reason(limit))
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmText)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            SegmentPicker(
                selection: $selection,
                options: ApprovalAllowFor.allCases
                    .filter { $0 != .days || days != nil }
                    .map { ($0, Self.label($0, days: days)) }
            )
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
