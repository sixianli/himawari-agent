import HimawariDesign
import SwiftUI

struct RulesPage: View {
    struct OpenedMemory: Hashable, Identifiable {
        let id: String
    }

    @State private var store: MemoryStore
    private let quietHours: QuietHours?
    @State private var selected: RuleSummary?
    @State private var pendingMemory: String?
    @State private var openedMemory: OpenedMemory?
    @State private var actionFailed = false
    private let talk: (String) -> Void
    private let opening: String?

    init(store: MemoryStore, quietHours: QuietHours?, opening: String? = nil, talk: @escaping (String) -> Void = { _ in }) {
        _store = State(initialValue: store)
        self.quietHours = quietHours
        self.opening = opening
        self.talk = talk
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignTokens.Her.pageGap) {
                content
                Text(M.rulesFooter)
                    .font(.footnote)
                    .foregroundStyle(Color.hmMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, DesignTokens.Size.pagePaddingX)
            .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        }
        .scrollIndicators(.hidden)
        .refreshable { await store.load() }
        .himawariScreenBackground()
        .navigationTitle(M.rules)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.large)
        #endif
        .task {
            await store.load()
            if let opening { selected = store.rule(opening) }
        }
        .sheet(item: $selected, onDismiss: openPendingMemory) { rule in
            RuleDetailSheet(
                rule: rule,
                close: { selected = nil },
                respond: { action in
                    Task {
                        let reason = action == "undo" ? M.confirmUndoRule : M.confirmReconfirmRule
                        do {
                            try await store.respond(rule, action: action, reason: reason)
                            selected = nil
                        } catch {
                            actionFailed = true
                        }
                    }
                },
                talk: {
                    selected = nil
                    talk(M.ruleDraft(rule.summary))
                },
                openMemory: { id in
                    pendingMemory = id
                    selected = nil
                }
            )
            .presentationDetents([.large])
            .presentationCornerRadius(DesignTokens.Radius.sheetTop)
            .presentationBackground(Color.hmBackground)
        }
        .alert(M.actionFailed, isPresented: $actionFailed) {}
        .navigationDestination(item: $openedMemory) { memory in
            MemoryRootView(store: store, opening: .memory(memory.id), talk: talk)
        }
    }

    @ViewBuilder private var content: some View {
        switch store.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
        case .failed:
            EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        case .loaded:
            RuleList(rules: Self.ownPageRules(store.rules, quietHours: quietHours)) { selected = $0 }
        }
    }

    nonisolated static func ownPageRules(_ rules: [RuleSummary], quietHours: QuietHours?) -> [RuleSummary] {
        let shownInSettings = Set(quietHours?.rules.map(\.ruleId) ?? [])
        return rules.filter { !shownInSettings.contains($0.ruleId) }
    }

    private func openPendingMemory() {
        guard let id = pendingMemory else { return }
        pendingMemory = nil
        openedMemory = OpenedMemory(id: id)
    }
}

struct RuleList: View {
    let rules: [RuleSummary]
    let open: (RuleSummary) -> Void

    var body: some View {
        if rules.isEmpty {
            EmptyStateView(Text(M.noRules)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        } else {
            GroupedSection {
                ForEach(Array(rules.enumerated()), id: \.element.id) { index, rule in
                    Button { open(rule) } label: {
                        MemoryRow(text: rule.summary, detail: status(rule))
                    }
                    .buttonStyle(.pressable)
                    if index < rules.count - 1 { RowSeparator() }
                }
            }
        }
    }

    private func status(_ rule: RuleSummary) -> String? {
        if rule.status == "needs_review" { return M.ruleNeedsReview }
        return rule.enforced ? nil : M.rulePaused
    }
}
