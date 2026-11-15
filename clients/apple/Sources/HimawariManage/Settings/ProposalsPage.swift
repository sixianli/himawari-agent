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
                if let notice {
                    Text(notice).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                }
                if list.proposals.isEmpty {
                    EmptyStateView(Text(M.noProposals)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    Text(M.proposalsSubtitle).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                    VStack(spacing: PL.gap) {
                        ForEach(list.proposals) { proposal in
                            ProposalRow(
                                proposal: proposal,
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

typealias PL = ManageLayout.ProposalCard

struct ProposalRow: View {
    let proposal: Proposal
    let busy: Bool
    let respond: (ProposalAction) -> Void
    @State private var open = false

    private var firstReason: String? {
        proposal.evidence.lazy.compactMap { $0.text }.first { !$0.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: SL.rowGap) {
            VStack(alignment: .leading, spacing: SL.rowTextGap) {
                Text(proposal.summary).hmType(PL.title).foregroundStyle(Color.hmText)
                Text(proposal.effect).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
            }
            if proposal.hasEvidence {
                Button { withAnimation(.snappy) { open.toggle() } } label: {
                    HStack(alignment: .top, spacing: PL.buttonGap) {
                        Text(firstReason ?? M.proposalWhy)
                            .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                            .lineLimit(open ? nil : 2)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Icon(.chevronRight, size: PL.chevron).foregroundStyle(Color.hmMuted)
                            .rotationEffect(.degrees(open ? -90 : 90))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(open ? M.proposalHideWhy : M.proposalWhy)
                .accessibilityAddTraits(.isButton)
                if open { evidence }
            }
            HStack(spacing: PL.buttonGap) {
                Button { respond(.reject) } label: { Text(M.proposalDecline) }
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: PL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                if proposal.adoptable {
                    Button { respond(.adopt) } label: { Text(M.proposalAdopt) }
                        .buttonStyle(CapsuleButtonStyle(.primary, height: PL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        .disabled(proposal.requiresFullRead && proposal.hasEvidence && !open)
                }
            }
            .disabled(busy)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard()
    }

    private var evidence: some View {
        VStack(alignment: .leading, spacing: SL.rowTextGap) {
            ForEach(Array(proposal.evidence.enumerated()), id: \.offset) { _, item in
                if let text = item.text, !text.isEmpty {
                    Text(text).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmText)
                }
                ForEach(Array(item.figures.enumerated()), id: \.offset) { _, figure in
                    VStack(alignment: .leading, spacing: 0) {
                        Text(M.proposalFigure(figure)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmText)
                        Text(figure.definition).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                }
            }
        }
    }
}
