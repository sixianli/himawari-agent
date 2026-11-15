import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct GrantsPage: View {
    let store: SettingsStore
    let back: () -> Void
    @Environment(\.pairingClock) private var pairingClock
    @State private var open: String?
    @State private var notice: String?
    @State private var failedId: String?
    @State private var busy: String?

    init(store: SettingsStore, opening: String? = nil, notice: String? = nil, back: @escaping () -> Void) {
        self.store = store
        self.back = back
        _open = State(initialValue: opening)
        _notice = State(initialValue: notice)
    }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.grantsTitle, leading: .back, action: back)
            if let grants = store.grants {
                if grants.isEmpty {
                    EmptyStateView(Text(M.noGrants)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    SettingsGroup(label: nil) {
                        ForEach(Array(grants.enumerated()), id: \.element.id) { index, grant in
                            row(grant, last: index == grants.count - 1)
                        }
                    }
                }
                if let notice {
                    Text(notice).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task {
            await store.reloadGrants()
            await store.reloadCapabilities()
        }
        .refreshable { await store.reloadGrants() }
    }

    private func title(_ grant: GrantSummary) -> String {
        let capability = (store.waitingCapabilities + store.capabilitiesInUse + store.capabilitiesDisabled)
            .first { $0.capabilityRef == grant.capabilityRef }?.displayName
        return M.grantTitle(label: grant.label, capability: capability)
    }

    private func row(_ grant: GrantSummary, last: Bool) -> some View {
        let name = title(grant)
        let expanded = open == grant.id
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: SL.rowGap) {
                Button { withAnimation(.snappy) { open = expanded ? nil : grant.id } } label: {
                    VStack(alignment: .leading, spacing: SL.rowTextGap) {
                        Text(name).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                        Text(M.grantSubtitle(grantedAt: grant.grantedAt, endsAt: grant.endsAt, uses: grant.uses, now: pairingClock ?? Date()))
                            .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isButton)
                Button { revoke(grant, name: name) } label: {
                    Text(M.grantRevoke).hmType(SL.rowValue).foregroundStyle(Color.hmSun)
                }
                .buttonStyle(.plain)
                .disabled(busy == grant.id)
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if failedId == grant.id {
                Text(M.grantRevokeFailed).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmDanger)
                    .padding(.bottom, SL.rowPaddingVertical)
            }
            if expanded {
                VStack(alignment: .leading, spacing: SL.rowTextGap) {
                    ForEach(Array(grant.detailLines.enumerated()), id: \.offset) { _, line in
                        Text(line).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, SL.rowPaddingVertical)
            }
            if !last { RowSeparator() }
        }
    }

    private func revoke(_ grant: GrantSummary, name: String) {
        notice = nil
        failedId = nil
        busy = grant.id
        Task {
            defer { busy = nil }
            do {
                switch try await store.revoke(grant, reason: M.confirmRevokeGrant(name)) {
                case .revoked(let affected): notice = M.grantRevoked(affected: affected)
                case .gone: notice = M.grantGone
                }
            } catch where Self.declined(error) {
            } catch {
                failedId = grant.id
            }
        }
    }

    private static func declined(_ error: Error) -> Bool {
        !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError)
    }
}
