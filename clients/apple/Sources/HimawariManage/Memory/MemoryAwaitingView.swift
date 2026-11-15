import HimawariCore
import HimawariDesign
import SwiftUI

struct AwaitingRow: Identifiable {
    let id: String
    let title: String
    let status: String
    let decline: String
    let confirm: String
    let open: () -> Void
    let respond: (Bool) -> Void
}

struct MemoryAwaitingList: View {
    let store: MemoryStore
    let run: (String, @escaping () async throws -> Void) -> Void
    let busy: String?
    let openMemory: (String) -> Void

    var body: some View {
        let rows = self.rows
        let undoable = undoRows
        if rows.isEmpty && undoable.isEmpty {
            EmptyStateView(Text(M.nothingAwaiting)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        } else {
            VStack(alignment: .leading, spacing: 24) {
                if !rows.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        GroupedSection {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                DecisionRow(
                                    title: row.title,
                                    detail: nil,
                                    status: row.status,
                                    decline: row.decline,
                                    confirm: row.confirm,
                                    openLabel: row.title,
                                    busy: busy == row.id,
                                    open: row.open,
                                    respond: row.respond
                                )
                                if index < rows.count - 1 { RowSeparator() }
                            }
                        }
                        if let snapshot = store.awaiting, MemoryAwaiting.hiddenExternal(snapshot) > 0 {
                            Text(M.hiddenExternal(MemoryAwaiting.hiddenExternal(snapshot)))
                                .hmType(DesignTokens.TypeScale.caption)
                                .foregroundStyle(Color.hmMuted)
                                .padding(.horizontal, DesignTokens.Size.rowGap)
                        }
                    }
                }
                if !undoable.isEmpty {
                    GroupedSection(Text(M.recentlyHandled)) {
                        ForEach(Array(undoable.enumerated()), id: \.element.id) { index, row in
                            HStack(spacing: DesignTokens.Size.rowGap) {
                                MemoryRow(text: row.title, detail: row.detail)
                                Button(M.undo, action: row.undo)
                                    .buttonStyle(RowPillButtonStyle(filled: true))
                                    .disabled(busy == row.id)
                            }
                            if index < undoable.count - 1 { RowSeparator() }
                        }
                    }
                }
            }
        }
    }

    private var rows: [AwaitingRow] {
        guard let snapshot = store.awaiting else { return [] }
        var result: [AwaitingRow] = []
        for request in snapshot.pending {
            result.append(AwaitingRow(
                id: request.id, title: request.text, status: M.approvalStatus(request),
                decline: M.dontRemember, confirm: M.remember, open: {},
                respond: { approved in run(request.id) { try await store.answer(request, approved: approved) } }
            ))
        }
        for proposal in snapshot.externalProposals.items {
            result.append(AwaitingRow(
                id: proposal.id, title: proposal.text, status: M.externalStatus(proposal),
                decline: M.proposalDecline, confirm: M.keepIt, open: {},
                respond: { keep in run(proposal.id) { try await store.answer(proposal, keep: keep) } }
            ))
        }
        for question in snapshot.personQuestions {
            result.append(AwaitingRow(
                id: question.id, title: M.personQuestion(question), status: M.personStatus,
                decline: M.notSame, confirm: M.sameOne, open: {},
                respond: { same in run(question.id) { try await store.answer(question, same: same) } }
            ))
        }
        for reminder in snapshot.reminders {
            result.append(AwaitingRow(
                id: reminder.id, title: reminder.text, status: M.reminderStatus(reminder) ?? "",
                decline: M.stopReminding, confirm: M.snoozeReminder, open: {},
                respond: { snooze in
                    run(reminder.id) { try await store.answer(reminder, action: snooze ? "snooze" : "dismiss") }
                }
            ))
        }
        for group in MemoryAwaiting.reviewGroups(store.review) {
            result.append(AwaitingRow(
                id: group.id, title: group.text ?? M.memoryGone,
                status: M.reviewReason(group.sources.first?.reason ?? ""),
                decline: M.openMemory, confirm: M.looksFine, open: { openMemory(group.memoryId) },
                respond: { dismiss in
                    if dismiss { run(group.id) { try await store.dismiss(group) } } else { openMemory(group.memoryId) }
                }
            ))
        }
        return result
    }

    struct UndoRow: Identifiable {
        let id: String
        let title: String
        let detail: String?
        let undo: () -> Void
    }

    private var undoRows: [UndoRow] {
        guard let snapshot = store.awaiting else { return [] }
        var result: [UndoRow] = []
        for batch in snapshot.externalProposals.batches where batch.committed + batch.rejected > 0 {
            result.append(UndoRow(id: batch.id, title: M.externalBatch(batch), detail: dayText(batch.decidedAt), undo: {
                run(batch.id) { try await store.undo(batch) }
            }))
        }
        for change in snapshot.undoableTidyUps {
            result.append(UndoRow(id: change.id, title: change.text, detail: [M.tidyAction(change.action), dayText(change.createdAt)].compactMap { $0 }.joined(separator: " · "), undo: {
                run(change.id) { try await store.undo(change) }
            }))
        }
        for review in snapshot.undoableReviews {
            result.append(UndoRow(id: review.id, title: M.conversationReview(review), detail: dayText(review.finishedAt), undo: {
                run(review.id) { try await store.undo(review) }
            }))
        }
        return result
    }

    private func dayText(_ iso: String) -> String? {
        Timestamp.parse(iso).map(M.shortDate)
    }
}
