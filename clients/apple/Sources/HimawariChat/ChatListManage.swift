import HimawariCore
import HimawariDesign
import Observation
import SwiftUI

@MainActor
@Observable
final class ThreadListActions {
    let store: ChatStore
    let open: (String?) -> Void
    var renaming: ThreadSummary?
    var renameText = ""
    var deleting: ThreadSummary?
    var archivedOpen = false
    var notice: String?

    init(store: ChatStore, open: @escaping (String?) -> Void) {
        self.store = store
        self.open = open
    }

    func report(_ result: ThreadManageResult) {
        switch result {
        case .done: break
        case .conflict: notice = L.text("chat.manage.conflict")
        case .blocked: notice = L.text("chat.delete.blocked")
        case .failed: notice = L.text("chat.manage.failed")
        }
    }

    func beginRename(_ thread: ThreadSummary) {
        renameText = store.title(for: thread) ?? ""
        renaming = thread
    }

    func commitRename() {
        guard let thread = renaming else { return }
        renaming = nil
        let text = renameText
        Task { report(await store.rename(thread, to: text)) }
    }

    func togglePin(_ thread: ThreadSummary) {
        let pinned = !store.isPinned(thread)
        Task { report(await store.setPinned(thread, pinned)) }
    }

    func archive(_ thread: ThreadSummary) {
        Task { report(await store.archive(thread)) }
    }

    func setLocale(_ thread: ThreadSummary, _ locale: AnswerLocale) {
        Task { report(await store.setAnswerLocale(thread, locale)) }
    }

    func fork(_ thread: ThreadSummary) {
        Task {
            if let threadId = await store.fork(thread) {
                open(threadId)
            } else {
                notice = L.text("chat.fork.failed")
            }
        }
    }
}

struct MenuLabel: View {
    let title: String
    let icon: IconName

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Icon(icon, size: DesignTokens.IconSize.glassButton)
        }
    }
}

public struct AnswerLanguageButtons: View {
    private let store: ChatStore
    private let thread: ThreadSummary
    private let onResult: (ThreadManageResult) -> Void

    public init(store: ChatStore, thread: ThreadSummary, onResult: @escaping (ThreadManageResult) -> Void = { _ in }) {
        self.store = store
        self.thread = thread
        self.onResult = onResult
    }

    public var body: some View {
        ForEach(AnswerLocale.allCases, id: \.rawValue) { locale in
            Button {
                Task { onResult(await store.setAnswerLocale(thread, locale)) }
            } label: {
                if locale.rawValue == thread.answerLocale {
                    Label { Text(L.text("chat.locale.\(locale.rawValue)")) } icon: { Icon(.check, size: DesignTokens.IconSize.glassButton) }
                } else {
                    Text(L.text("chat.locale.\(locale.rawValue)"))
                }
            }
        }
    }
}

struct ThreadMenuItems: View {
    let actions: ThreadListActions
    let thread: ThreadSummary

    var body: some View {
        let pinned = actions.store.isPinned(thread)
        Button { actions.togglePin(thread) } label: {
            MenuLabel(title: L.text(pinned ? "chat.action.unpin" : "chat.action.pin"), icon: pinned ? .pinnedOff : .pin)
        }
        Button { actions.beginRename(thread) } label: {
            MenuLabel(title: L.text("chat.action.rename"), icon: .pencil)
        }
        Menu {
            AnswerLanguageButtons(store: actions.store, thread: thread, onResult: actions.report)
        } label: {
            MenuLabel(title: L.text("chat.action.answerLocale"), icon: .language)
        }
        Button { actions.fork(thread) } label: {
            MenuLabel(title: L.text("chat.action.fork"), icon: .gitFork)
        }
        Button { actions.archive(thread) } label: {
            MenuLabel(title: L.text("chat.action.archive"), icon: .archive)
        }
        Button(role: .destructive) { actions.deleting = thread } label: {
            MenuLabel(title: L.text("chat.action.delete"), icon: .trash)
        }
    }
}

struct ChatSearchBar: View {
    @Binding var text: String
    let close: () -> Void
    @FocusState private var focused: Bool

    init(text: Binding<String>, close: @escaping () -> Void) {
        _text = text
        self.close = close
    }

    var body: some View {
        HStack(spacing: DesignTokens.Size.composerGap * 2) {
            Icon(.search, size: DesignTokens.IconSize.glassButton)
                .foregroundStyle(Color.hmMuted)
            TextField(L.text("chat.search.placeholder"), text: $text)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .focused($focused)
                .submitLabel(.search)
                .onSubmit { focused = false }
                .autocorrectionDisabled()
            Button(action: close) {
                Icon(.x, size: DesignTokens.IconSize.chevron)
                    .foregroundStyle(Color.hmMuted)
                    .frame(minWidth: DesignTokens.Size.minTapTarget, minHeight: DesignTokens.Size.minTapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(L.text("chat.search.close")))
        }
        .padding(.leading, DesignTokens.Size.rowGap)
        .frame(minHeight: DesignTokens.Size.pill)
        .background(Color.hmFill, in: Capsule())
        .onAppear { focused = true }
    }
}

struct DeleteThreadSheet: View {
    let actions: ThreadListActions
    let thread: ThreadSummary
    @Environment(\.dismiss) private var dismiss
    @State private var impact: ThreadDeletionImpact?
    @State private var loaded: Bool
    @State private var working = false
    private let preset: Bool

    init(actions: ThreadListActions, thread: ThreadSummary, impact: ThreadDeletionImpact? = nil, loaded: Bool = false) {
        self.actions = actions
        self.thread = thread
        _impact = State(initialValue: impact)
        _loaded = State(initialValue: loaded)
        preset = loaded
    }

    private var title: String { actions.store.title(for: thread) ?? L.text("chat.untitled") }

    private var activeCount: Int { impact?.activeTasks.count ?? 0 }

    private var message: String {
        guard loaded else { return L.text("chat.delete.checking") }
        guard let impact else { return L.text("chat.delete.unknown") }
        if activeCount > 0 { return L.format("chat.delete.tasks", activeCount) }
        if !impact.deletionAllowed { return L.text("chat.delete.blocked") }
        return L.text("chat.delete.body")
    }

    private var canDelete: Bool {
        guard let impact else { return false }
        return impact.deletionAllowed || activeCount > 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Size.rowGap) {
            Text(L.text("chat.delete.title"))
                .hmType(DesignTokens.TypeScale.sheetTitle)
                .foregroundStyle(Color.hmText)
            Text(title)
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmMuted)
                .lineLimit(1)
            Text(message)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack(spacing: DesignTokens.Size.rowGap) {
                Button(L.text("chat.cancel")) { dismiss() }
                    .buttonStyle(CapsuleButtonStyle(.secondary))
                Button(L.text(activeCount > 0 ? "chat.delete.pauseAndDelete" : "chat.action.delete")) { confirm() }
                    .buttonStyle(CapsuleButtonStyle(.primary))
                    .disabled(!canDelete || working)
                    .opacity(canDelete && !working ? 1 : DesignTokens.Opacity.emptyMark)
            }
        }
        .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
        .padding(.top, DesignTokens.Size.sheetPaddingTop)
        .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.hmBackground.ignoresSafeArea())
        .presentationDetents([.medium])
        .presentationCornerRadius(DesignTokens.Radius.sheetTop)
        .task {
            guard !preset else { return }
            impact = await actions.store.deletionImpact(of: thread)
            loaded = true
        }
    }

    private func confirm() {
        working = true
        let pausing = activeCount > 0
        Task {
            let result = await actions.store.delete(thread, pausingActiveTasks: pausing)
            working = false
            dismiss()
            actions.report(result)
        }
    }
}

struct ArchivedThreadsView: View {
    let actions: ThreadListActions
    @Environment(\.dismiss) private var dismiss
    @Environment(\.listClock) private var listClock
    @State private var items: [ThreadSummary]?
    @State private var failed = false
    private let preset: Bool

    init(actions: ThreadListActions, items: [ThreadSummary]? = nil) {
        self.actions = actions
        _items = State(initialValue: items)
        preset = items != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                GlassCircleButton(Text(L.text("chat.back")), action: { dismiss() }) {
                    Icon(.chevronLeft, size: DesignTokens.IconSize.glassButton)
                }
                Spacer()
            }
            .padding(.top, DesignTokens.Size.rowGap)
            ScreenTitle(Text(L.text("chat.archived")))
                .padding(.top, DesignTokens.Size.composerGap)
            content
        }
        .padding(.horizontal, DesignTokens.Size.chatPaddingX)
        .himawariScreenBackground()
        .task { if !preset { await load() } }
    }

    @ViewBuilder
    private var content: some View {
        if let items {
            if items.isEmpty {
                EmptyStateView(Text(L.text("chat.archived.empty")))
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, thread in
                            HStack(spacing: DesignTokens.Size.rowGap) {
                                Button {
                                    dismiss()
                                    actions.open(thread.threadId)
                                } label: {
                                    ChatListRow(
                                        title: actions.store.title(for: thread) ?? L.text("chat.untitled"),
                                        snippet: nil,
                                        time: RelativeTime.label(thread.updatedAt, now: listClock ?? Date()),
                                        showsSeparator: false
                                    )
                                }
                                .buttonStyle(.plain)
                                Button(L.text("chat.restore")) { restore(thread) }
                                    .buttonStyle(RowPillButtonStyle(filled: true))
                            }
                            .overlay(alignment: .bottom) {
                                if index < items.count - 1 { RowSeparator() }
                            }
                        }
                    }
                }
                .scrollIndicators(.hidden)
            }
        } else if failed {
            EmptyStateView(Text(L.text("chat.archived.failed")))
        } else {
            Color.clear.frame(maxHeight: .infinity)
        }
    }

    private func load() async {
        failed = false
        if let loaded = await actions.store.archivedThreads() {
            items = loaded
        } else {
            failed = true
        }
    }

    private func restore(_ thread: ThreadSummary) {
        Task {
            let result = await actions.store.restore(thread)
            if result == .done {
                items?.removeAll { $0.threadId == thread.threadId }
            } else {
                actions.report(result)
            }
        }
    }
}

struct ThreadManagementPresentations: ViewModifier {
    let actions: ThreadListActions

    func body(content: Content) -> some View {
        @Bindable var actions = actions
        return content
            .alert(L.text("chat.rename.title"), isPresented: Binding(get: { actions.renaming != nil }, set: { if !$0 { actions.renaming = nil } })) {
                TextField(L.text("chat.untitled"), text: $actions.renameText)
                Button(L.text("chat.rename.save")) { actions.commitRename() }
                Button(L.text("chat.cancel"), role: .cancel) {}
            }
            .alert(actions.notice ?? "", isPresented: Binding(get: { actions.notice != nil }, set: { if !$0 { actions.notice = nil } })) {
                Button(L.text("common.ok"), role: .cancel) {}
            }
            .sheet(item: $actions.deleting) { thread in
                DeleteThreadSheet(actions: actions, thread: thread)
            }
            .hmCover(isPresented: $actions.archivedOpen) {
                ArchivedThreadsView(actions: actions)
            }
    }
}
