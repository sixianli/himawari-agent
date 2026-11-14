import HimawariDesign
import SwiftUI

struct CapabilitiesPage: View {
    let store: SettingsStore
    let back: () -> Void

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.capabilities, leading: .back, action: back)
            if store.capabilityCount == 0 {
                EmptyStateView(Text(M.noCapabilities)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
            section(M.waitingForYou, store.waitingCapabilities)
            section(M.inUse, store.capabilitiesInUse)
        }
    }

    @ViewBuilder private func section(_ label: String, _ items: [CapabilitySummary]) -> some View {
        if !items.isEmpty {
            SettingsGroup(label: label) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    SettingsRow(icon: nil, title: item.displayName, last: index == items.count - 1)
                }
            }
        }
    }
}
