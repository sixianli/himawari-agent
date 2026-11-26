import HimawariCore
import HimawariDesign
import HimawariSenses
import HimawariShare
import SwiftUI

struct HandoverEntryRows: View {
    var body: some View {
        ForEach(Array(HandoverEntry.allCases.enumerated()), id: \.element) { index, entry in
            if index > 0 { RowSeparator() }
            NavigationLink {
                HandoverEntryRoute(entry)
            } label: {
                SenseRow(
                    icon: entry == .share ? .share2 : .compass,
                    title: entry.title,
                    detail: entry.detail,
                    status: (entry == .share ? ShareEntryStatus.share : .safari).label,
                    statusColor: Color.hmMuted
                )
            }
            .buttonStyle(.pressable)
        }
    }
}
