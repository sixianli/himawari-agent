import HimawariCore
import HimawariDesign
import SwiftUI

public struct ChatListView: View {
    private let store: ChatStore
    private let open: (String?) -> Void

    public init(store: ChatStore, open: @escaping (String?) -> Void) {
        self.store = store
        self.open = open
    }

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ScreenTitle(Text(L.text("chat.title")))
                    if store.threads.isEmpty && !store.loadingThreads {
                        EmptyStateView(Text(L.text("chat.empty")))
                            .frame(minHeight: 300)
                    }
                    LazyVStack(spacing: 0) {
                        ForEach(Array(store.threads.enumerated()), id: \.element.id) { index, thread in
                            Button {
                                open(thread.threadId)
                            } label: {
                                ChatListRow(
                                    title: store.title(for: thread) ?? L.text("chat.untitled"),
                                    snippet: store.lastMessageText(in: thread.threadId),
                                    time: RelativeTime.label(thread.updatedAt),
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
                Icon(.edit, size: 24)
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
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.hmText)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(time)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.hmMuted)
                    .fixedSize()
            }
            if let snippet, !snippet.isEmpty {
                Text(snippet)
                    .font(.system(size: 15))
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
