import HimawariCore
import HimawariDesign
import SwiftUI

public struct ChatView: View {
    private let store: ChatStore
    private let close: () -> Void
    private let openHerPage: (() -> Void)?
    @State private var threadId: String?
    @State private var draft = ""
    @State private var creating = false
    @State private var createFailed = false
    @State private var createRequestId = ChatStore.newRequestId()
    @State private var bannerHeight: CGFloat = 0
    @FocusState private var inputFocused: Bool
    @Environment(\.transcriptScrollsToTopAfter) private var scrollToTopAfter
    @Environment(\.chatVoice) private var voice
    @Environment(\.chatOpensAttachSheet) private var opensAttachSheet
    @Environment(\.chatCanAttach) private var canAttach
    @Environment(\.chatStopRun) private var stopRun
    @Environment(\.chatTalk) private var talk
    @Environment(\.chatOpensTalk) private var opensTalk
    @State private var talking = false
    @State private var talkStartedAfter: String?
    @State private var stopping = false
    @State private var attachments: [ChatAttachment] = []
    @State private var attachOpen = false
    @State private var attachProblem: String?
    @State private var sendRequestId = OutgoingMessage.newId()
    @State private var hold: HoldPhase?
    @State private var heard = ""
    @State private var dictating = false
    @State private var dictationPrefix = ""

    public init(store: ChatStore, threadId: String?, draft: String = "", openHerPage: (() -> Void)? = nil, close: @escaping () -> Void) {
        self.store = store
        self.close = close
        self.openHerPage = openHerPage
        _threadId = State(initialValue: threadId)
        _draft = State(initialValue: draft)
    }

    private static let headerHeight = DesignTokens.Chat.avatar + DesignTokens.Chat.avatarGap + DesignTokens.Chat.avatarLabelHeight
    private static let navBottom = DesignTokens.Size.navTop + headerHeight
    private static let fadeBelowNav: CGFloat = 32

    public var body: some View {
        withTalkFeed
    }

    private var layers: some View {
        ZStack {
            if threadId == nil {
                NewChatPrompt()
            } else {
                transcript
            }
            EdgeFade(.top, height: Self.navBottom + Self.fadeBelowNav, solid: Self.navBottom / (Self.navBottom + Self.fadeBelowNav))
                .frame(maxHeight: .infinity, alignment: .top)
                .ignoresSafeArea()
            chrome
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }

    private var chrome: some View {
        VStack(spacing: 0) {
            header
            if store.connection != .online, threadId != nil {
                OfflineBanner()
                    .padding(.top, 2)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { bannerHeight = $0 }
                    .transition(.opacity)
            }
            Spacer(minLength: 0)
            #if os(iOS)
            if !attachments.isEmpty {
                AttachmentChips(attachments: attachments) { id in attachments.removeAll { $0.id == id } }
                    .padding(.bottom, DesignTokens.Chat.listMarkerGap)
            }
            #endif
            composer
                .padding(.horizontal, DesignTokens.Size.composerInsetX)
                .padding(.bottom, DesignTokens.Size.composerBottom)
                .background(alignment: .bottom) { EdgeFade(.bottom, height: DesignTokens.Size.fadeComposer, solid: 0.4).ignoresSafeArea() }
        }
    }

    @ViewBuilder
    private var composer: some View {
        if let activeTalk {
            ChatTalkBar(talk: activeTalk, end: endTalk)
                .transition(.opacity)
        } else {
            ChatInputBar(
                text: $draft,
                focused: $inputFocused,
                sending: creating,
                hasAttachments: !attachments.isEmpty,
                voice: voice != nil,
                hold: hold,
                dictating: dictating,
                openAttach: attachAction,
                stop: stopAction,
                startTalk: talkStarter,
                toggleDictation: toggleDictation,
                holdChanged: holdChanged,
                send: submit
            )
        }
    }

    private var activeTalk: (any ChatTalk)? {
        talking ? talk : nil
    }

    private var talkStarter: (() -> Void)? {
        guard talk != nil else { return nil }
        return startTalk
    }

    private var talkHeard: String {
        guard let activeTalk else { return "" }
        return activeTalk.heard
    }

    private var avatarBusy: Bool {
        if let activeTalk, activeTalk.phase == .herTurn { return true }
        guard let threadId else { return creating }
        return store.isBusy(in: threadId)
    }

    private var attachAction: (() -> Void)? {
        guard Self.attachAvailable, canAttach else { return nil }
        return {
            inputFocused = false
            attachOpen = true
        }
    }

    private var withLifecycle: some View {
        layers
            .animation(.easeInOut(duration: 0.2), value: store.connection)
            .himawariScreenBackground()
            .task(id: threadId) {
                if let threadId {
                    store.watch(threadId)
                    await store.load(threadId)
                }
            }
            .onDisappear {
                store.unwatch()
                Task { await voice?.cancel() }
                if talking { endTalk() }
            }
            .onAppear {
                if opensAttachSheet, canAttach { attachOpen = true }
                if opensTalk, talk != nil { talking = true }
            }
    }

    private var problemShown: Binding<Bool> {
        Binding(get: { attachProblem != nil }, set: { if !$0 { attachProblem = nil } })
    }

    private var withAlerts: some View {
        withLifecycle
            .alert(L.text("chat.createFailed"), isPresented: $createFailed) {
                Button(L.text("common.ok"), role: .cancel) {}
            }
            .alert(attachProblem ?? "", isPresented: problemShown) {
                Button(L.text("common.ok"), role: .cancel) {}
            }
            #if os(iOS)
            .sheet(isPresented: $attachOpen) { attachSheet }
            #endif
    }

    #if os(iOS)
    private var attachSheet: some View {
        AttachSheet(room: max(0, Self.attachRoom - attachments.count)) { picked in
            attachments += picked
            attachOpen = false
        } failed: { failure in
            attachProblem = Self.describe(failure)
        } close: {
            attachOpen = false
        }
        .presentationDetents([.medium])
        .presentationCornerRadius(DesignTokens.Radius.sheetTop)
    }
    #endif

    private var streamingNow: String? {
        guard let threadId else { return nil }
        return store.streamingText(in: threadId)
    }

    private var attachmentIds: [String] {
        attachments.map(\.id)
    }

    private var withTalkFeed: some View {
        withAlerts
            .onChange(of: streamingNow) { _, text in
                guard talking, let text else { return }
                talk?.herReply(text, finished: false)
            }
            .onChange(of: lastAgentReply) { _, reply in
                guard talking, let reply, reply.id != talkStartedAfter else { return }
                talk?.herReply(reply.text, finished: true)
            }
            .onChange(of: attachmentIds) { _, _ in
                sendRequestId = OutgoingMessage.newId()
            }
    }

    #if os(iOS)
    private static let attachAvailable = true
    #else
    private static let attachAvailable = false
    #endif
    private static let attachRoom = 10

    private var header: some View {
        ZStack(alignment: .top) {
            HStack {
                GlassCircleButton(Text(L.text("chat.back")), action: close) {
                    Icon(.chevronLeft, size: DesignTokens.IconSize.glassButton)
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .frame(height: DesignTokens.Chat.avatar)
            if let openHerPage {
                Button(action: openHerPage) {
                    HimawariAvatar(busy: avatarBusy)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(L.text("chat.herPage")))
                .accessibilityAddTraits(.isHeader)
            } else {
                HimawariAvatar(busy: avatarBusy)
                    .accessibilityAddTraits(.isHeader)
            }
        }
        .frame(maxWidth: .infinity)
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
                if !talkHeard.isEmpty {
                    OwnerBubble(text: talkHeard)
                        .opacity(DesignTokens.Chat.talkHeardOpacity)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, store.connection != .online ? Self.headerHeight + 39 + bannerHeight : Self.headerHeight + 18)
            .padding(.bottom, 110)
        }
        .defaultScrollAnchor(.bottom, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
    }

    private var stopAction: (() -> Void)? {
        guard let stopRun, let threadId, !stopping, let run = store.workingRun(in: threadId) else { return nil }
        return {
            Haptics.shared.report(.stopPressed)
            stopping = true
            Task {
                defer { stopping = false }
                do {
                    try await stopRun(threadId, run)
                } catch {
                    attachProblem = L.text("chat.stop.failed")
                }
                await store.load(threadId)
            }
        }
    }

    struct AgentReply: Equatable {
        let id: String
        let text: String
    }

    private var lastAgentReply: AgentReply? {
        guard let threadId, let message = store.messages(in: threadId).last(where: { $0.role == .agent }) else { return nil }
        return AgentReply(id: message.messageId, text: store.texts[message.contentRef] ?? "")
    }

    private func startTalk() {
        guard let talk else { return }
        if dictating { stopDictation() }
        inputFocused = false
        talkStartedAfter = lastAgentReply?.id
        withAnimation(.easeInOut(duration: 0.15)) { talking = true }
        Task {
            do {
                try await talk.begin { said in deliver(said, clearDraft: false) }
            } catch {
                withAnimation(.easeInOut(duration: 0.15)) { talking = false }
                attachProblem = L.text("chat.talk.failed")
            }
        }
    }

    private func endTalk() {
        withAnimation(.easeInOut(duration: 0.15)) { talking = false }
        Task { await talk?.end() }
    }

    private func submit() {
        if dictating { stopDictation() }
        deliver(draft, clearDraft: true)
    }

    private func deliver(_ text: String, clearDraft: Bool) {
        let carried = attachments
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !carried.isEmpty, !creating else { return }
        Haptics.shared.report(.messageSent)
        if let threadId, carried.isEmpty {
            if clearDraft { draft = "" }
            Task { await store.send(text, in: threadId) }
            return
        }
        creating = true
        Task {
            defer { creating = false }
            let target: String
            if let threadId {
                target = threadId
            } else {
                do {
                    target = try await store.newThread(requestId: createRequestId)
                    threadId = target
                } catch {
                    createFailed = true
                    return
                }
            }
            do {
                try await store.send(text, attachments: carried, requestId: sendRequestId, in: target)
                attachments.removeAll { item in carried.contains { $0.id == item.id } }
                sendRequestId = OutgoingMessage.newId()
                if clearDraft { draft = "" }
            } catch let problem as ChatAttachmentProblem {
                attachProblem = Self.describe(problem)
            } catch {
                attachProblem = L.text("attach.problem.upload")
            }
        }
    }

    static func describe(_ problem: ChatAttachmentProblem) -> String {
        switch problem {
        case .serverOutdated: L.text("attach.problem.outdated")
        case let .tooMany(limit): L.format("attach.problem.tooMany", limit)
        case .tooLarge: L.text("attach.problem.tooLarge")
        case .uploadFailed: L.text("attach.problem.upload")
        }
    }

    #if os(iOS)
    static func describe(_ failure: AttachFailure) -> String {
        switch failure {
        case .noLocation: L.text("attach.problem.location")
        case .tooLarge: L.text("attach.problem.tooLarge")
        case .unreadable: L.text("attach.problem.unreadable")
        }
    }
    #endif

    private func holdChanged(_ event: HoldEvent) {
        guard let voice else { return }
        switch event {
        case .began:
            guard hold == nil else { return }
            Haptics.shared.report(.holdToTalkStarted)
            heard = ""
            hold = .listening("")
            Task {
                do {
                    try await voice.start { text in
                        heard = text
                        if case .listening = hold { hold = .listening(text) }
                    }
                } catch {
                    hold = nil
                }
            }
        case let .moved(outside):
            guard hold != nil else { return }
            hold = outside ? .cancelling : .listening(heard)
        case .ended:
            guard let phase = hold else { return }
            hold = nil
            Haptics.shared.report(.holdToTalkReleased)
            Task {
                if phase == .cancelling {
                    await voice.cancel()
                    return
                }
                let said = await voice.finish().trimmingCharacters(in: .whitespacesAndNewlines)
                guard !said.isEmpty else { return }
                deliver(said, clearDraft: false)
            }
        }
    }

    private func toggleDictation() {
        guard let voice else { return }
        if dictating {
            stopDictation()
            return
        }
        dictating = true
        dictationPrefix = draft.isEmpty ? "" : draft + " "
        Task {
            do {
                try await voice.start { text in
                    if dictating { draft = dictationPrefix + text }
                }
            } catch {
                dictating = false
            }
        }
    }

    private func stopDictation() {
        guard let voice, dictating else { return }
        dictating = false
        let prefix = dictationPrefix
        Task {
            let said = await voice.finish()
            if !said.isEmpty { draft = prefix + said }
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
            AnswerText(text: text ?? "", muted: failed)
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
        let shown = MessageAttachments.shown(text)
        HStack {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: DesignTokens.Chat.listGap) {
                if !shown.text.isEmpty {
                    Text(shown.text)
                        .hmType(DesignTokens.TypeScale.bubble)
                        .textSelection(.enabled)
                }
                ForEach(Array(shown.attachments.enumerated()), id: \.offset) { _, attachment in
                    Label {
                        Text(attachment.name).hmType(DesignTokens.TypeScale.secondary)
                    } icon: {
                        Icon(attachment.kind == .image ? .photo : .fileText, size: DesignTokens.Chat.attachRowIcon)
                    }
                    .foregroundStyle(Color.hmMuted)
                }
            }
            .foregroundStyle(Color.hmText)
            .padding(.vertical, 14)
            .padding(.horizontal, 18)
            .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous))
            .frame(maxWidth: DesignTokens.Size.bubbleMaxWidth, alignment: .trailing)
        }
    }
}

struct StreamingAnswer: View {
    let text: String

    var body: some View {
        AnswerText(text: text, streaming: true)
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
