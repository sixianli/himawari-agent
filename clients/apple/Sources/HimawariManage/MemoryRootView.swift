import HimawariCore
import HimawariDesign
import SwiftUI

public struct MemoryRootView: View {
    enum Tab: Hashable {
        case remembered
        case rules
    }

    enum Opening: Equatable {
        case memory(String)
        case edit(String)
        case rule(String)
    }

    @State private var store: MemoryStore
    @State private var tab: Tab = .remembered
    @State private var selected: MemoryItem?
    @State private var editing: MemoryItem?
    @State private var pendingEdit: MemoryItem?
    @State private var pendingMemory: String?
    @State private var detailHeight: CGFloat = 0
    @State private var actionFailed = false
    @State private var selectedRule: RuleSummary?
    private let talk: (String) -> Void
    private let opening: Opening?

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, talk: @escaping (String) -> Void) {
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        _store = State(initialValue: MemoryStore(gateway: gateway))
        self.talk = talk
        opening = nil
    }

    init(store: MemoryStore, tab: Tab = .remembered, opening: Opening? = nil, talk: @escaping (String) -> Void = { _ in }) {
        _store = State(initialValue: store)
        _tab = State(initialValue: tab)
        self.opening = opening
        self.talk = talk
    }

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ScreenTitle(Text(M.memoryTitle))
                    MemorySegment(selection: $tab)
                    content
                }
                .padding(.horizontal, DesignTokens.Size.pagePaddingX)
                .padding(.top, 14)
                .padding(.bottom, DesignTokens.Size.fadeTabBar)
            }
            .scrollIndicators(.hidden)
            .refreshable { await store.load() }

            GlassCircleButton(Text(M.search), action: {}) {
                Icon(.search, size: DesignTokens.IconSize.glassButton)
            }
            .padding(.trailing, DesignTokens.Size.pagePaddingX)
            .padding(.top, 10)
        }
        .himawariScreenBackground()
        .task {
            await store.load()
            open(opening)
        }
        .sheet(item: $selected, onDismiss: openPendingEdit) { item in
            MemoryDetailSheet(
                item: item,
                basis: M.basis(store.basis(item)),
                lastUsed: M.lastUsed(item.lastUsedAt.flatMap(Timestamp.parse)),
                close: { selected = nil },
                delete: { delete(item) },
                edit: {
                    pendingEdit = item
                    selected = nil
                }
            )
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { detailHeight = $0 }
            .presentationDetents(detailHeight > 0 ? [.height(detailHeight)] : [.medium])
            .presentationCornerRadius(ManageLayout.DetailSheetShape.cornerRadius)
            .presentationBackground(Color.hmBackground)
            .onAppear { Haptics.shared.report(.sheetSettled) }
        }
        .sheet(item: $editing) { item in
            MemoryEditSheet(original: item.text, close: { editing = nil }) { text in
                await perform { try await store.correct(item, text: text, reason: M.confirmEdit) }
            }
            .presentationDetents([.large])
            .presentationCornerRadius(DesignTokens.Radius.sheetTop)
            .presentationBackground(Color.hmBackground)
        }
        .sheet(item: $selectedRule, onDismiss: openPendingMemory) { rule in
            RuleDetailSheet(
                rule: rule,
                close: { selectedRule = nil },
                respond: { action in
                    Task {
                        let reason = action == "undo" ? M.confirmUndoRule : M.confirmReconfirmRule
                        if await perform({ try await store.respond(rule, action: action, reason: reason) }) {
                            selectedRule = nil
                        }
                    }
                },
                talk: {
                    selectedRule = nil
                    talk(M.ruleDraft(rule.summary))
                },
                openMemory: { id in
                    pendingMemory = id
                    selectedRule = nil
                }
            )
            .presentationDetents([.large])
            .presentationCornerRadius(DesignTokens.Radius.sheetTop)
            .presentationBackground(Color.hmBackground)
        }
        .alert(M.actionFailed, isPresented: $actionFailed) {}
    }

    private func open(_ opening: Opening?) {
        let memories = store.overview?.memories ?? []
        switch opening {
        case .memory(let id): selected = memories.first { $0.memoryId == id }
        case .edit(let id): editing = memories.first { $0.memoryId == id }
        case .rule(let id): selectedRule = store.rules.first { $0.ruleId == id }
        case nil: break
        }
    }

    private func openPendingMemory() {
        guard let id = pendingMemory else { return }
        pendingMemory = nil
        open(.memory(id))
    }

    private func openPendingEdit() {
        editing = pendingEdit
        pendingEdit = nil
    }

    private func delete(_ item: MemoryItem) {
        Task {
            if await perform({ try await store.delete(item, reason: M.confirmDelete) }) { selected = nil }
        }
    }

    private func perform(_ action: () async throws -> Void) async -> Bool {
        do {
            try await action()
            return true
        } catch {
            actionFailed = true
            return false
        }
    }

    @ViewBuilder private var content: some View {
        switch (store.phase, tab) {
        case (.loading, _):
            ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
        case (.failed, _):
            EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        case (.loaded, .remembered):
            RememberedList(store: store) { selected = $0 }
        case (.loaded, .rules):
            RuleList(rules: store.rules) { selectedRule = $0 }
        }
    }
}

struct MemorySegment: View {
    @Binding var selection: MemoryRootView.Tab

    var body: some View {
        SegmentPicker(selection: $selection, options: [(.remembered, M.remembered), (.rules, M.rules)])
    }
}

struct RememberedList: View {
    let store: MemoryStore
    let open: (MemoryItem) -> Void

    var body: some View {
        let groups = store.groups(categoryLabel: M.category)
        if groups.isEmpty {
            EmptyStateView(Text(M.nothingRemembered)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        } else {
            VStack(alignment: .leading, spacing: 24) {
                ForEach(groups) { group in
                    GroupedSection(Text(group.label)) {
                        ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                            Button { open(item) } label: {
                                MemoryRow(text: item.text, detail: detail(store.provenance(item)))
                            }
                            .buttonStyle(.plain)
                            if index < group.items.count - 1 { RowSeparator() }
                        }
                    }
                }
            }
        }
    }

    private func detail(_ provenance: MemoryProvenance) -> String {
        switch provenance {
        case .inferred: M.inferred
        case .imported(let source): M.imported(source)
        case .toldBy(let date): M.toldBy(date.map(M.shortDate))
        }
    }
}

struct MemoryRow: View {
    let text: String
    let detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
            if let detail {
                Text(detail)
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .padding(.vertical, DesignTokens.Size.rowGap)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
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
                    .buttonStyle(.plain)
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
