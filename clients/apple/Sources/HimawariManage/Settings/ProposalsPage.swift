import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct ProposalsPage: View {
    let store: SettingsStore
    let back: () -> Void
    @State private var failed = false
    @State private var notice: String?
    @State private var busy: String?

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.proposalsTitle, leading: .back, action: back)
            if let list = store.proposals {
                if list.proposals.isEmpty {
                    EmptyStateView(Text(M.noProposals)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    Text(M.proposalsSubtitle).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                    if let notice {
                        Text(notice).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                            .padding(.horizontal, SL.groupLabelPadding)
                    }
                    SettingsGroup(label: nil) {
                        ForEach(Array(list.proposals.enumerated()), id: \.element.id) { index, proposal in
                            ProposalRow(
                                proposal: proposal,
                                last: index == list.proposals.count - 1,
                                busy: busy == proposal.id,
                                respond: { respond(proposal, $0) }
                            )
                        }
                    }
                    Text(M.proposalsFootnote(limit: list.limit, days: list.expiresAfterDays))
                        .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.reloadProposals() }
        .refreshable { await store.reloadProposals() }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func respond(_ proposal: Proposal, _ action: ProposalAction) {
        notice = nil
        busy = proposal.id
        Task {
            defer { busy = nil }
            do {
                let reason = action == .adopt ? M.confirmAdopt : M.confirmReject
                switch try await store.respond(proposal, action, reason: reason) {
                case .done(.adopt): notice = M.proposalAdopted
                case .done(.reject): notice = nil
                case .changed: notice = M.proposalChanged
                case .gone: notice = M.proposalGone
                }
            } catch {
                failed = true
            }
        }
    }
}

struct ProposalRow: View {
    let proposal: Proposal
    let last: Bool
    let busy: Bool
    let respond: (ProposalAction) -> Void
    @State private var open = false

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: SL.rowGap) {
                VStack(alignment: .leading, spacing: SL.rowTextGap) {
                    Text(proposal.summary).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    Text(proposal.effect).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
                if proposal.hasEvidence {
                    Button { withAnimation(.snappy) { open.toggle() } } label: {
                        Text(open ? M.proposalHideWhy : M.proposalWhy)
                            .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                            .frame(minHeight: DesignTokens.Size.minTapTarget, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(.isButton)
                    if open { evidence }
                }
                HStack(spacing: SL.rowGap) {
                    Spacer(minLength: 0)
                    Button { respond(.reject) } label: {
                        Text(M.proposalDecline).hmType(SL.rowValue).foregroundStyle(Color.hmMuted)
                            .frame(minHeight: DesignTokens.Size.minTapTarget)
                    }
                    .buttonStyle(.plain)
                    if proposal.adoptable {
                        Button { respond(.adopt) } label: {
                            Text(M.proposalAdopt).hmType(SL.rowValue).foregroundStyle(Color.hmSun)
                                .frame(minHeight: DesignTokens.Size.minTapTarget)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .disabled(busy)
            }
            .padding(.vertical, SL.rowPaddingVertical)
            if !last { RowSeparator() }
        }
    }

    private var evidence: some View {
        VStack(alignment: .leading, spacing: SL.rowTextGap) {
            ForEach(Array(proposal.evidence.enumerated()), id: \.offset) { _, item in
                if let text = item.text, !text.isEmpty {
                    Text(text).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmText)
                }
                ForEach(item.figures, id: \.name) { figure in
                    VStack(alignment: .leading, spacing: 0) {
                        Text(M.proposalFigure(figure)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmText)
                        Text(figure.definition).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                }
            }
        }
    }
}
