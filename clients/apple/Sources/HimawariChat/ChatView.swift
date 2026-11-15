import HimawariCore
import HimawariDesign
import SwiftUI

public struct ChatView: View {
    private let store: ChatStore
    private let close: () -> Void
    @State private var threadId: String?
    @State private var draft = ""
    @State private var creating = false
    @State private var createFailed = false
    @State private var createRequestId = ChatStore.newRequestId()
    @State private var bannerHeight: CGFloat = 0
    @FocusState private var inputFocused: Bool
    @Environment(\.transcriptScrollsToTopAfter) private var scrollToTopAfter

    public init(store: ChatStore, threadId: String?, draft: String = "", close: @escaping () -> Void) {
        self.store = store
        self.close = close
        _threadId = State(initialValue: threadId)
        _draft = State(initialValue: draft)
    }

    private static let navBottom = DesignTokens.Size.navTop + DesignTokens.Size.glassButton
    private static let fadeBelowNav: CGFloat = 32

    private var title: String {
        guard let threadId, let thread = store.threads.first(where: { $0.threadId == threadId }) else {
            return L.text("chat.untitled")
        }
        return store.title(for: thread) ?? L.text("chat.untitled")
    }

    public var body: some View {
        ZStack {
            if threadId == nil {
                NewChatPrompt()
            } else {
                transcript
            }
            EdgeFade(.top, height: Self.navBottom + Self.fadeBelowNav, solid: Self.navBottom / (Self.navBottom + Self.fadeBelowNav))
                .frame(maxHeight: .infinity, alignment: .top)
                .ignoresSafeArea()
            VStack(spacing: 0) {
                header
                if store.connection != .online, threadId != nil {
                    OfflineBanner()
                        .padding(.top, 2)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bannerHeight = $0 }
                        .transition(.opacity)
                }
                Spacer(minLength: 0)
                ChatInputBar(text: $draft, focused: $inputFocused, sending: creating, send: submit)
                    .padding(.horizontal, DesignTokens.Size.composerInsetX)
                    .padding(.bottom, DesignTokens.Size.composerBottom)
                    .background(alignment: .bottom) { EdgeFade(.bottom, height: DesignTokens.Size.fadeComposer, solid: 0.4).ignoresSafeArea() }
            }
            .ignoresSafeArea(.container, edges: .bottom)
        }
        .animation(.easeInOut(duration: 0.2), value: store.connection)
        .himawariScreenBackground()
        .task(id: threadId) {
            if let threadId {
                store.watch(threadId)
                await store.load(threadId)
            }
        }
        .onDisappear { store.unwatch() }
        .alert(L.text("chat.createFailed"), isPresented: $createFailed) {
            Button(L.text("common.ok"), role: .cancel) {}
        }
    }

    private var header: some View {
        ZStack {
            HStack {
                GlassCircleButton(Text(L.text("chat.back")), action: close) {
                    Icon(.chevronLeft, size: DesignTokens.IconSize.glassButton)
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            Text(threadId == nil ? "" : title)
                .hmType(DesignTokens.TypeScale.navTitle)
                .foregroundStyle(Color.hmText)
                .lineLimit(1)
                .padding(.horizontal, 76)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(height: DesignTokens.Size.navBarHeight)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            transcriptScroll
                .task {
                    guard let scrollToTopAfter, let threadId, let first = store.transcript(in: threadId).first else { return }
                    try? await Task.sleep(for: .seconds(scrollToTopAfter))
                    withAnimation(.easeInOut(duration: 3)) { proxy.scrollTo(first.id, anchor: .top) }
                }
        }
    }

    private var transcriptScroll: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if let threadId {
                    ForEach(store.transcript(in: threadId)) { item in
                        switch item {
                        case let .message(message):
                            MessageRow(role: message.role, text: store.texts[message.contentRef], failed: message.status == .failed)
                        case let .process(runId):
                            if let line = store.processLine(for: runId, in: threadId) {
                                ProcessRowView(line: line, failed: store.run(runId, in: threadId)?.status == "failed")
                                    .task(id: runId) { await store.loadExecution(runId, in: threadId) }
                            }
                        }
                    }
                    if let streaming = store.streamingText(in: threadId) {
                        StreamingAnswer(text: streaming)
                    }
                    ForEach(store.queuedMessages(in: threadId)) { item in
                        QueuedMessageRow(item: item, online: store.connection == .online) {
                            Task { await store.retry(item.id) }
                        } discard: {
                            Task { await store.discard(item.id) }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, store.connection != .online ? 94 + bannerHeight : 73)
            .padding(.bottom, 110)
        }
        .defaultScrollAnchor(.top, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
    }

    private func submit() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !creating else { return }
        Haptics.shared.report(.messageSent)
        if let threadId {
            draft = ""
            Task { await store.send(text, in: threadId) }
            return
        }
        creating = true
        Task {
            defer { creating = false }
            do {
                let created = try await store.newThread(requestId: createRequestId)
                threadId = created
                draft = ""
                await store.send(text, in: created)
            } catch {
                createFailed = true
            }
        }
    }
}

struct MessageRow: View {
    let role: MessageRole
    let text: String?
    let failed: Bool

    var body: some View {
        switch role {
        case .owner:
            OwnerBubble(text: text ?? "")
        case .agent:
            Text(text ?? "")
                .font(.himawari(DesignTokens.TypeScale.answer.size, weight: .medium))
                .hmLineHeight(DesignTokens.TypeScale.answer.lineHeight)
                .foregroundStyle(failed ? Color.hmMuted : Color.hmText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        case .system:
            Text(text ?? "")
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct OwnerBubble: View {
    let text: String

    var body: some View {
        HStack {
            Spacer(minLength: 0)
            Text(text)
                .hmType(DesignTokens.TypeScale.bubble)
                .foregroundStyle(Color.hmText)
                .padding(.vertical, 14)
                .padding(.horizontal, 18)
                .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous))
                .frame(maxWidth: DesignTokens.Size.bubbleMaxWidth, alignment: .trailing)
                .textSelection(.enabled)
        }
    }
}

struct StreamingAnswer: View {
    let text: String

    var body: some View {
        Text("\(answer) \(dot)")
            .hmLineHeight(DesignTokens.TypeScale.answer.lineHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var answer: Text {
        Text(text)
            .font(.himawari(DesignTokens.TypeScale.answer.size, weight: .medium))
            .foregroundStyle(Color.hmText)
    }

    private var dot: Text {
        Text(Image(size: CGSize(width: DesignTokens.Size.streamingDot, height: DesignTokens.Size.streamingDot)) { context in
            context.fill(Path(ellipseIn: CGRect(x: 0, y: 0, width: DesignTokens.Size.streamingDot, height: DesignTokens.Size.streamingDot)), with: .color(DesignTokens.Colors.streamingDot.color))
        })
    }
}

struct NewChatPrompt: View {
    var body: some View {
        VStack(spacing: 18) {
            SunflowerMark()
                .frame(width: DesignTokens.Size.emptyMarkNewChat, height: DesignTokens.Size.emptyMarkNewChat)
            Text(L.text("chat.new.prompt"))
                .hmType(DesignTokens.TypeScale.emptyTitleNewChat)
                .foregroundStyle(Color.hmText)
        }
        .padding(.bottom, DesignTokens.Size.fadeTabBar - 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            RadialGradient(colors: [Color.hmGlow, .clear], center: .center, startRadius: 0, endRadius: DesignTokens.Size.newChatGlowRadius / 2)
        }
        .ignoresSafeArea(.container)
    }
}

struct OfflineBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color.hmMuted)
                .frame(width: DesignTokens.Size.offlineDot, height: DesignTokens.Size.offlineDot)
            Text(L.text("chat.offline"))
                .hmType(DesignTokens.TypeScale.offlineBanner)
                .foregroundStyle(Color.hmText)
        }
        .padding(.vertical, DesignTokens.Size.offlineBannerPaddingVertical)
        .padding(.horizontal, DesignTokens.Size.offlineBannerPaddingHorizontal)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.offlineBanner, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct QueuedMessageRow: View {
    let item: OutboxItem
    let online: Bool
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            OwnerBubble(text: item.message.text)
            Group {
                switch item.state {
                case .failed:
                    HStack(spacing: 12) {
                        Text(L.text("chat.queued.failed"))
                            .foregroundStyle(Color.hmDanger)
                        Button(L.text("chat.queued.retry"), action: retry)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.hmSun)
                        Button(L.text("chat.queued.discard"), action: discard)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.hmSun)
                    }
                case .waiting where !online || item.attempts > 0:
                    HStack(spacing: 12) {
                        Text(L.text("chat.queued.offline"))
                            .foregroundStyle(Color.hmDanger)
                        Button(L.text("chat.queued.retryNow"), action: retry)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.hmSun)
                    }
                case .waiting, .sending:
                    Text(L.text("chat.queued.sending"))
                        .foregroundStyle(Color.hmMuted)
                }
            }
            .hmType(DesignTokens.TypeScale.caption)
            .buttonStyle(.plain)
            .frame(minHeight: DesignTokens.Size.minTapTarget)
            .contentShape(Rectangle())
            .padding(.vertical, -(DesignTokens.Size.minTapTarget - (DesignTokens.TypeScale.caption.lineHeight ?? DesignTokens.Size.minTapTarget)) / 2)
            .padding(.trailing, 6)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

struct ChatInputBar: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let sending: Bool
    let send: () -> Void

    private var canSend: Bool {
        !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: DesignTokens.Size.composerGap) {
            TextField(L.text("chat.input.placeholder"), text: $text, axis: .vertical)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .lineLimit(1...6)
                .focused(focused)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, 6 + DesignTokens.Size.composerPadding)
                .padding(.vertical, (DesignTokens.Size.composerHeight - DesignTokens.Size.composerButton) / 2 + 12)
                .frame(minHeight: DesignTokens.Size.composerHeight)
            if canSend {
                Button(action: send) {
                    Icon(.arrowUp, size: DesignTokens.IconSize.glassButton)
                        .foregroundStyle(Color.hmOnText)
                        .frame(width: DesignTokens.Size.composerButton, height: DesignTokens.Size.composerButton)
                        .background(Color.hmSpeak, in: Circle())
                }
                .buttonStyle(.plain)
                .padding((DesignTokens.Size.composerHeight - DesignTokens.Size.composerButton) / 2)
                .padding(.trailing, DesignTokens.Size.composerPadding - (DesignTokens.Size.composerHeight - DesignTokens.Size.composerButton) / 2)
                .accessibilityLabel(Text(L.text("chat.send")))
                .transition(.scale.combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.15), value: canSend)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.composer, style: .continuous))
    }
}
