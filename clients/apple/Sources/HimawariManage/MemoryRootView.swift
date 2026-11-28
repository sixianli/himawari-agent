import HimawariCore
import HimawariDesign
import SwiftUI

public struct MemoryRootView: View {
    enum SearchState: Equatable {
        case idle
        case searching
        case found([MemorySearchHit])
        case failed
    }

    enum Opening: Equatable {
        case memory(String)
        case edit(String)
    }

    @State private var store: MemoryStore
    @State private var selected: MemoryItem?
    @State private var editing: MemoryItem?
    @State private var pendingEdit: MemoryItem?
    @State private var detailHeight: CGFloat = 0
    @State private var actionFailed = false
    @State private var trashOpen = false
    @State private var query = ""
    @State private var search = SearchState.idle
    private let talk: (String) -> Void
    private let opening: Opening?

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, talk: @escaping (String) -> Void) {
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        _store = State(initialValue: MemoryStore(gateway: gateway))
        self.talk = talk
        opening = nil
    }

    init(store: MemoryStore, opening: Opening? = nil, talk: @escaping (String) -> Void = { _ in }) {
        _store = State(initialValue: store)
        self.opening = opening
        self.talk = talk
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if Self.trimmed(query).isEmpty {
                    content
                } else {
                    MemorySearchList(store: store, query: Self.trimmed(query), state: search) { selected = $0 }
                }
            }
            .padding(.horizontal, DesignTokens.Size.pagePaddingX)
            .padding(.top, 8)
            .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.load() }
        .himawariScreenBackground()
        .navigationTitle(M.memoryTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.large)
        #endif
        .searchable(text: $query, prompt: Text(M.searchPrompt))
        .task(id: Self.trimmed(query)) { await runSearch(Self.trimmed(query)) }
        .task {
            await store.load()
            open(opening)
        }
        .sheet(item: $selected, onDismiss: openPendingEdit) { item in
            MemoryDetailSheet(
                item: item,
                basis: M.basis(store.basis(item)),
                lastUsed: M.lastUsed(item.lastUsedAt.flatMap(Timestamp.parse)),
                versions: MemoryStore.previousVersions(of: item),
                useVersion: { historyId in
                    Task {
                        if await perform({ try await store.restoreVersion(item, historyId: historyId, reason: M.confirmRestoreVersion) }) { selected = nil }
                    }
                },
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
        .alert(M.actionFailed, isPresented: $actionFailed) {}
        .navigationDestination(isPresented: $trashOpen) {
            MemoryTrashPage(store: store) { trashOpen = false }
        }
    }

    static func trimmed(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func runSearch(_ text: String) async {
        guard !text.isEmpty else {
            search = .idle
            return
        }
        if case .found = search {} else { search = .searching }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        do {
            let hits = try await store.search(text)
            guard !Task.isCancelled else { return }
            search = .found(hits.filter { !$0.isRule })
        } catch {
            guard !Task.isCancelled else { return }
            search = .failed
        }
    }

    private func open(_ opening: Opening?) {
        let memories = store.overview?.memories ?? []
        switch opening {
        case .memory(let id): selected = memories.first { $0.memoryId == id }
        case .edit(let id): editing = memories.first { $0.memoryId == id }
        case nil: break
        }
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
        switch store.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
        case .failed:
            EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        case .loaded:
            RememberedList(store: store, openTrash: { trashOpen = true }) { selected = $0 }
        }
    }
}

struct MemorySearchList: View {
    let store: MemoryStore
    let query: String
    let state: MemoryRootView.SearchState
    let openMemory: (MemoryItem) -> Void

    var body: some View {
        switch state {
        case .idle, .searching:
            ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
        case .failed:
            EmptyStateView(Text(M.searchFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        case .found(let hits) where hits.isEmpty:
            EmptyStateView(Text(M.noSearchResults(query))).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        case .found(let hits):
            GroupedSection {
                ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                    row(hit)
                    if index < hits.count - 1 { RowSeparator() }
                }
            }
        }
    }

    @ViewBuilder private func row(_ hit: MemorySearchHit) -> some View {
        let detail = M.category(hit.category)
        if let item = store.memory(hit.memoryId) {
            Button { openMemory(item) } label: { MemoryRow(text: hit.text, detail: detail) }
                .buttonStyle(.pressable)
        } else {
            MemoryRow(text: hit.text, detail: detail)
        }
    }
}

struct RememberedList: View {
    let store: MemoryStore
    let openTrash: () -> Void
    let open: (MemoryItem) -> Void

    var body: some View {
        let groups = store.groups(categoryLabel: M.category)
        let trashed = store.trashed.count
        if groups.isEmpty && trashed == 0 {
            EmptyStateView(Text(M.nothingRemembered)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        } else {
            VStack(alignment: .leading, spacing: 24) {
                ForEach(groups) { group in
                    GroupedSection(Text(group.label)) {
                        ForEach(Array(group.items.enumerated()), id: \.element.id) { index, item in
                            Button { open(item) } label: {
                                MemoryRow(text: item.text, detail: detail(store.provenance(item)))
                            }
                            .buttonStyle(.pressable)
                            if index < group.items.count - 1 { RowSeparator() }
                        }
                    }
                }
                if trashed > 0 {
                    GroupedSection {
                        Button(action: openTrash) {
                            HStack {
                                MemoryRow(text: M.trashRow(trashed), detail: nil)
                                Icon(.chevronRight, size: DesignTokens.IconSize.chevron).foregroundStyle(Color.hmMuted)
                            }
                        }
                        .buttonStyle(.pressable)
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
