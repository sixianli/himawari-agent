import HimawariDesign
import SwiftUI

struct CapabilitiesPage: View {
    let store: SettingsStore
    let back: () -> Void
    @State private var failed = false
    @State private var reactivationFailure: [String: String] = [:]

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.capabilities, leading: .back, action: back)
            if store.capabilityCount == 0 {
                EmptyStateView(Text(M.noCapabilities)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
            section(M.waitingForYou, store.waitingCapabilities)
            section(M.inUse, store.capabilitiesInUse, switchable: true)
            section(M.disabledCapabilities, store.capabilitiesDisabled, disabled: true)
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    @ViewBuilder private func section(_ label: String, _ items: [CapabilitySummary], switchable: Bool = false, disabled: Bool = false) -> some View {
        if !items.isEmpty {
            SettingsGroup(label: label) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    SettingsRow(
                        icon: .puzzle,
                        title: item.displayName,
                        detail: disabled ? item.lastInvalidation.flatMap { M.disabledAt($0.occurredAt) } : nil,
                        note: disabled
                            ? item.lastInvalidation.flatMap { M.cancelledJobs($0.cancelledScheduledJobs) }
                            : M.capabilityExpansions(item.updateAssessment?.expansions ?? []),
                        warning: reactivationFailure[item.capabilityRef],
                        switchState: switchable ? turnOff(item) : (disabled ? turnOn(item) : nil),
                        last: index == items.count - 1
                    )
                }
            }
        }
    }

    private func turnOff(_ item: CapabilitySummary) -> Binding<Bool> {
        Binding(
            get: { true },
            set: { isOn in
                guard !isOn else { return }
                Task {
                    do {
                        try await store.disable(item, reason: M.confirmDisableCapability(item.displayName))
                    } catch {
                        failed = true
                    }
                }
            }
        )
    }

    private func turnOn(_ item: CapabilitySummary) -> Binding<Bool> {
        Binding(
            get: { false },
            set: { isOn in
                guard isOn else { return }
                reactivationFailure[item.capabilityRef] = nil
                Task {
                    do {
                        try await store.reactivate(item, reason: M.confirmReactivateCapability(item.displayName))
                    } catch where SettingsStore.isDeclined(error) {
                    } catch {
                        reactivationFailure[item.capabilityRef] = M.reactivateFailed
                    }
                }
            }
        )
    }
}
