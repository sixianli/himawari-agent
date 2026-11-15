import HimawariCore
import HimawariDesign
import SwiftUI

struct MemoryTidyPage: View {
    let store: MemoryStore
    let openMemory: (String) -> Void
    let back: () -> Void
    @State private var busy: String?
    @State private var failed = false

    var body: some View {
        VStack(spacing: 12) {
            NavigationHeader(title: Text(M.tidyTitle), back: back)
            ScrollView {
                content
                    .padding(.horizontal, DesignTokens.Size.pagePaddingX)
                    .padding(.top, 10)
                    .padding(.bottom, DesignTokens.Size.fadeTabBar)
            }
            .scrollIndicators(.hidden)
            .refreshable { await store.load() }
        }
        .himawariScreenBackground()
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    @ViewBuilder private var content: some View {
        let groups = MemoryTidy.reviewGroups(store.review)
        let recent = MemoryTidy.recent(store.tidy)
        if store.phase == .loading {
            ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
        } else if store.phase != .loaded {
            EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        } else if groups.isEmpty && recent.isEmpty {
            EmptyStateView(Text(M.nothingTidied)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        } else {
            VStack(alignment: .leading, spacing: 22) {
                if !groups.isEmpty {
                    GroupedSection(Text(M.tidyWaiting)) {
                        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                            DecisionRow(
                                title: group.text ?? M.memoryGone,
                                detail: nil,
                                status: M.reviewReason(group.sources.first?.reason ?? ""),
                                decline: M.openMemory,
                                confirm: M.looksFine,
                                openLabel: M.openMemory,
                                busy: busy == group.id,
                                open: { openMemory(group.memoryId) },
                                respond: { fine in
                                    if fine {
                                        run(group.id) { try await store.dismiss(group) }
                                    } else {
                                        openMemory(group.memoryId)
                                    }
                                }
                            )
                            if index < groups.count - 1 { RowSeparator() }
                        }
                    }
                }
                if !recent.isEmpty {
                    GroupedSection(Text(M.tidyRecent)) {
                        ForEach(Array(recent.enumerated()), id: \.element.id) { index, entry in
                            HStack(spacing: DesignTokens.Size.rowGap) {
                                MemoryRow(text: M.tidyRowTitle(entry), detail: M.tidyRowDetail(entry))
                                if entry.undoable {
                                    Button(M.undo) { run(entry.id) { try await store.undo(entry) } }
                                        .buttonStyle(RowPillButtonStyle(filled: true))
                                        .disabled(busy != nil)
                                        .opacity(busy == entry.id ? 0.5 : 1)
                                }
                            }
                            if index < recent.count - 1 { RowSeparator() }
                        }
                    }
                }
            }
        }
    }

    private func run(_ id: String, _ action: @escaping () async throws -> Void) {
        guard busy == nil else { return }
        busy = id
        Task {
            do {
                try await action()
            } catch {
                failed = true
            }
            busy = nil
        }
    }
}
