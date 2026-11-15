import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct GrantsPage: View {
    let store: SettingsStore
    let back: () -> Void
    @Environment(\.pairingClock) private var pairingClock
    @Environment(\.stillFrames) private var stillFrames
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
                    GrantsEmptyState()
                } else {
                    SettingsGroup(label: nil) {
                        ForEach(Array(grants.enumerated()), id: \.element.id) { index, grant in
                            row(grant, last: index == grants.count - 1)
                        }
                    }
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
        .overlay(alignment: .bottom) {
            if let notice {
                NoticeBar(text: notice)
                    .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: notice)
        .task(id: notice) {
            guard notice != nil, !stillFrames else { return }
            try? await Task.sleep(for: .seconds(Self.noticeSeconds))
            if !Task.isCancelled { notice = nil }
        }
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
                    if let endsAt = grant.endsAt {
                        Text(M.grantExpires(endsAt)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
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
            } catch where SettingsStore.isDeclined(error) {
            } catch {
                failedId = grant.id
            }
        }
    }

    private static let noticeSeconds = 4.0
}

struct NoticeBar: View {
    let text: String

    var body: some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.offlineBanner)
            .foregroundStyle(Color.hmText)
            .multilineTextAlignment(.leading)
            .padding(.vertical, DesignTokens.Size.offlineBannerPaddingVertical)
            .padding(.horizontal, DesignTokens.Size.offlineBannerPaddingHorizontal)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.offlineBanner, style: .continuous))
            .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
            .accessibilityElement(children: .combine)
    }
}

struct GrantsEmptyState: View {
    var body: some View {
        VStack(spacing: SL.rowGap) {
            SunflowerMark()
                .frame(width: DesignTokens.Size.emptyMark, height: DesignTokens.Size.emptyMark)
                .opacity(DesignTokens.Opacity.emptyMark)
            Text(M.noGrants)
                .hmType(DesignTokens.TypeScale.emptyTitle)
                .foregroundStyle(Color.hmText)
        }
        .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
    }
}
