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
    @FocusState private var inputFocused: Bool

    public init(store: ChatStore, threadId: String?, close: @escaping () -> Void) {
        self.store = store
        self.close = close
        _threadId = State(initialValue: threadId)
    }

    private var title: String {
        guard let threadId, let thread = store.threads.first(where: { $0.threadId == threadId }) else {
            return L.text("chat.untitled")
        }
        return store.title(for: thread) ?? L.text("chat.untitled")
    }

    public var body: some View {
        ZStack {
            transcript
            VStack(spacing: 0) {
                header
                Spacer(minLength: 0)
                ChatInputBar(text: $draft, focused: $inputFocused, sending: creating, send: submit)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                    .background(alignment: .bottom) { EdgeFade(.bottom, height: 130).ignoresSafeArea() }
            }
        }
        .himawariScreenBackground()
        .task(id: threadId) {
            if let threadId {
                store.watch(threadId)
                await store.load(threadId)
            } else {
                inputFocused = true
            }
        }
        .onDisappear { store.unwatch() }
        .alert(L.text("chat.createFailed"), isPresented: $createFailed) {
            Button(L.text("common.ok"), role: .cancel) {}
        }
    }

    private var header: some View {
        ZStack {
            EdgeFade(.top, height: 110).ignoresSafeArea()
            HStack {
                GlassCircleButton(Text(L.text("chat.back")), action: close) {
                    Icon(.chevronLeft, size: 24)
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.hmText)
                .lineLimit(1)
                .padding(.horizontal, 76)
                .accessibilityAddTraits(.isHeader)
        }
        .frame(height: 64)
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if let threadId {
                    ForEach(store.transcript(in: threadId)) { item in
                        switch item {
                        case let .message(message):
                            MessageRow(role: message.role, text: store.texts[message.contentRef], failed: message.status == .failed)
                        case let .process(runId):
                            if let line = store.processLine(for: runId, in: threadId) {
                                ProcessRowView(line: line)
                                    .task(id: runId) { await store.loadExecution(runId, in: threadId) }
                            }
                        }
                    }
                    if let streaming = store.streamingText(in: threadId) {
                        MessageRow(role: .agent, text: streaming, failed: false)
                    }
                    ForEach(store.queuedMessages(in: threadId)) { item in
                        QueuedMessageRow(item: item) {
                            Task { await store.retry(item.id) }
                        } discard: {
                            Task { await store.discard(item.id) }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 84)
            .padding(.bottom, 110)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
    }

    private func submit() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !creating else { return }
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
            HStack {
                Spacer(minLength: 60)
                Text(text ?? "")
                    .font(.system(size: 17))
                    .lineSpacing(4)
                    .foregroundStyle(Color.hmText)
                    .padding(.vertical, 14)
                    .padding(.horizontal, 18)
                    .background(Color.hmFill, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                    .textSelection(.enabled)
            }
        case .agent:
            Text(text ?? "")
                .font(.himawari(18, weight: .medium))
                .lineSpacing(8)
                .foregroundStyle(failed ? Color.hmDanger : Color.hmText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        case .system:
            Text(text ?? "")
                .font(.system(size: 13))
                .foregroundStyle(Color.hmMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct QueuedMessageRow: View {
    let item: OutboxItem
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            MessageRow(role: .owner, text: item.message.text, failed: false)
                .opacity(item.state == .failed ? 1 : 0.6)
            switch item.state {
            case .failed:
                HStack(spacing: 4) {
                    Text(L.text("chat.queued.failed"))
                        .foregroundStyle(Color.hmDanger)
                    Button(L.text("chat.queued.retry"), action: retry)
                        .foregroundStyle(Color.hmSun)
                        .frame(minHeight: 44)
                    Button(L.text("chat.queued.discard"), action: discard)
                        .foregroundStyle(Color.hmSun)
                        .frame(minHeight: 44)
                }
                .font(.system(size: 13))
            case .waiting, .sending:
                Text(L.text("chat.queued.sending"))
                    .font(.system(size: 13))
                    .foregroundStyle(Color.hmMuted)
            }
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
        HStack(alignment: .bottom, spacing: 6) {
            TextField(L.text("chat.input.placeholder"), text: $text, axis: .vertical)
                .font(.system(size: 17))
                .foregroundStyle(Color.hmText)
                .lineLimit(1...6)
                .focused(focused)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .frame(minHeight: 46)
            Button(action: send) {
                Icon(.arrowUp, size: 22)
                    .foregroundStyle(Color.hmOnText)
                    .frame(width: 46, height: 46)
                    .background(canSend ? Color.hmSpeak : Color.hmFillStrong, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(Text(L.text("chat.send")))
        }
        .padding(8)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 31, style: .continuous))
    }
}
