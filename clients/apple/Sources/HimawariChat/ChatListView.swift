import HimawariCore
import HimawariDesign
import SwiftUI

public struct ChatListView: View {
    private let store: ChatStore
    private let open: (String?) -> Void
    @Environment(\.listClock) private var listClock

    public init(store: ChatStore, open: @escaping (String?) -> Void) {
        self.store = store
        self.open = open
    }

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            if store.threads.isEmpty && !store.loadingThreads {
                VStack(alignment: .leading, spacing: 0) {
                    ScreenTitle(Text(L.text("chat.title"))).hidden()
                    ChatListEmptyState()
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .ignoresSafeArea(.container, edges: .bottom)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ScreenTitle(Text(L.text("chat.title")))
                    LazyVStack(spacing: 0) {
                        ForEach(Array(store.threads.enumerated()), id: \.element.id) { index, thread in
                            Button {
                                open(thread.threadId)
                            } label: {
                                ChatListRow(
                                    title: store.title(for: thread) ?? L.text("chat.untitled"),
                                    snippet: store.lastMessageText(in: thread.threadId),
                                    time: RelativeTime.label(thread.updatedAt, now: listClock ?? Date()),
                                    showsSeparator: index < store.threads.count - 1
                                )
                            }
                            .buttonStyle(.plain)
                            .onAppear { store.prefetch(thread.threadId) }
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 130)
            }
            .scrollIndicators(.hidden)
            .refreshable { await store.refreshThreads() }

            GlassCircleButton(Text(L.text("chat.new")), action: { open(nil) }) {
                Icon(ChromeIcon.newChat, size: DesignTokens.IconSize.glassButton)
            }
            .padding(.trailing, 16)
            .padding(.top, 10)
        }
        .himawariScreenBackground()
    }
}

struct ChatListRow: View {
    let title: String
    let snippet: String?
    let time: String
    let showsSeparator: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title)
                    .hmType(DesignTokens.TypeScale.navTitle)
                    .foregroundStyle(Color.hmText)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(time)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                    .fixedSize()
            }
            if let snippet, !snippet.isEmpty {
                Text(snippet)
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) {
            if showsSeparator { RowSeparator() }
        }
        .contentShape(Rectangle())
    }
}

struct ChatListEmptyState: View {
    var body: some View {
        VStack(spacing: 12) {
            SunflowerMark()
                .frame(width: DesignTokens.Size.emptyMark, height: DesignTokens.Size.emptyMark)
                .opacity(DesignTokens.Opacity.emptyMark)
            Text(L.text("chat.empty"))
                .hmType(DesignTokens.TypeScale.emptyTitle)
                .foregroundStyle(Color.hmText)
            Text(L.text("chat.empty.hint"))
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmMuted)
                .multilineTextAlignment(.center)
        }
        .padding(.bottom, DesignTokens.Size.fadeTabBar - 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
