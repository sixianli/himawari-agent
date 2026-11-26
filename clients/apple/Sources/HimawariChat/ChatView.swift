import HimawariCore
import HimawariDesign
import SwiftUI

public struct ChatView: View {
    private let store: ChatStore
    private let close: (() -> Void)?
    private let openHerPage: (() -> Void)?
    private let threadId: String
    @State private var draft = ""
    @State private var uploading = false
    @FocusState private var inputFocused: Bool
    @Environment(\.transcriptScrollsToTopAfter) private var scrollToTopAfter
    @Environment(\.chatVoice) private var voice
    @Environment(\.chatOpensAttachSheet) private var opensAttachSheet
    @Environment(\.chatOpensSelectText) private var opensSelectText
    @Environment(\.chatShowsCopied) private var showsCopied
    @Environment(\.chatStartsReplyTo) private var startsReplyTo
    @Environment(\.chatCanAttach) private var canAttach
    @Environment(\.chatStopRun) private var stopRun
    @Environment(\.chatChooseOption) private var chooseOption
    @Environment(\.chatTalk) private var talk
    @Environment(\.chatOwnerAwaited) private var ownerAwaited
    @Environment(\.chatOpensTalk) private var opensTalk
    @State private var talking = false
    @State private var talkStartedAfter: String?
    @State private var stopping = false
    @State private var attachments: [ChatAttachment] = []
    @State private var attachOpen = false
    @State private var attachSheetHeight: CGFloat = 0
    @State private var attachProblem: String?
    @State private var sendRequestId = OutgoingMessage.newId()
    @State private var hold: HoldPhase?
    @State private var heard = ""
    @State private var dictating = false
    @State private var dictation = DictationDraft()
    @State private var selecting: SelectableMessage?
    @State private var copiedCount = 0
    @State private var copiedShown = false
    @State private var replyingTo: ThreadMessage?
    @State private var flashing: String?
    @State private var backgroundOpen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(iOS)
    @State private var safari: SafariLink?
    #endif

    public init(store: ChatStore, threadId: String, draft: String = "", openHerPage: (() -> Void)? = nil, close: (() -> Void)? = nil) {
        self.store = store
        self.close = close
        self.openHerPage = openHerPage
        self.threadId = threadId
        _draft = State(initialValue: draft)
    }

    private static let headerHeight = DesignTokens.Chat.puckTop + DesignTokens.Chat.puckSize

    public var body: some View {
        withTalkFeed
    }

    private var layers: some View {
        ZStack {
            transcript
            if showsEmptyFlower {
                EmptyChatFlower()
                    .transition(.opacity.animation(reduceMotion ? nil : .easeOut(duration: DesignTokens.Chat.emptyFadeSeconds)))
            }
            statusBarFade
            chrome
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }

    private var showsEmptyFlower: Bool {
        close == nil
            && store.transcript(in: threadId).isEmpty
            && store.queuedMessages(in: threadId).isEmpty
            && store.streamingText(in: threadId) == nil
            && talkHeard.isEmpty
    }

    private var statusBarFade: some View {
        GeometryReader { proxy in
            EdgeFade(.top, height: proxy.safeAreaInsets.top, solid: 0)
                .offset(y: -proxy.safeAreaInsets.top)
        }
        .allowsHitTesting(false)
    }

    private var chrome: some View {
        VStack(spacing: 0) {
            header
            Spacer(minLength: 0)
            if copiedShown {
                CopiedToast()
                    .padding(.bottom, DesignTokens.Chat.copiedToastLift)
                    .transition(reduceMotion ? .identity : .opacity)
            }
            #if os(iOS)
            if !attachments.isEmpty {
                AttachmentChips(attachments: attachments) { id in attachments.removeAll { $0.id == id } }
                    .padding(.bottom, DesignTokens.Chat.listMarkerGap)
            }
            #endif
            if let replyingTo, activeTalk == nil {
                ReplyComposerBar(quote: quote(of: replyingTo)) { self.replyingTo = nil }
                    .padding(.horizontal, DesignTokens.Size.composerInsetX)
                    .padding(.bottom, DesignTokens.Chat.listMarkerGap)
                    .transition(reduceMotion ? .identity : .opacity)
            }
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
                sending: uploading,
                hasAttachments: !attachments.isEmpty,
                voice: voice != nil,
                hold: hold,
                dictating: dictating,
                offline: store.offlineShown,
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
        if ownerAwaited { return true }
        if let activeTalk, activeTalk.phase == .herTurn { return true }
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
            .animation(.easeInOut(duration: 0.2), value: store.offlineShown)
            .himawariScreenBackground()
            .task(id: threadId) {
                store.watch(threadId)
                await store.load(threadId)
            }
            .onDisappear {
                store.unwatch()
                Task { await voice?.cancel() }
                if talking { endTalk() }
            }
            .onAppear {
                if opensAttachSheet, canAttach { attachOpen = true }
                if showsCopied { copiedShown = true }
                if let startsReplyTo { replyingTo = store.messages(in: threadId).first { $0.messageId == startsReplyTo } }
                if let opensSelectText, let message = store.messages(in: threadId).first(where: { $0.messageId == opensSelectText }) {
                    selecting = SelectableMessage(id: message.messageId, text: store.texts[message.contentRef] ?? "", fromAgent: message.role == .agent)
                }
                if opensTalk, talk != nil { talking = true }
            }
    }

    private var problemShown: Binding<Bool> {
        Binding(get: { attachProblem != nil }, set: { if !$0 { attachProblem = nil } })
    }

    private var withAlerts: some View {
        withLifecycle
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
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { attachSheetHeight = $0 }
        .presentationDetents([attachSheetHeight > 0 ? .height(attachSheetHeight) : .medium])
        .presentationCornerRadius(DesignTokens.Radius.sheetTop)
    }
    #endif

    private var streamingNow: String? {
        store.streamingText(in: threadId)
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
            .task(id: copiedCount) {
                guard copiedCount > 0 else { return }
                try? await Task.sleep(for: .seconds(DesignTokens.Chat.copiedToastSeconds))
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { copiedShown = false }
            }
            #if os(iOS)
            .sheet(item: $selecting) { message in
                SelectTextSheet(message: message) { selecting = nil }
            }
            .fullScreenCover(item: $safari) { link in
                SafariView(url: link.url).ignoresSafeArea()
            }
            .environment(\.openURL, OpenURLAction { url in
                guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return .systemAction }
                safari = SafariLink(url: url)
                return .handled
            })
            #endif
    }

    private func copyToPasteboard(_ text: String) {
        #if os(iOS)
        Pasteboard.copy(text)
        #endif
        withAnimation(reduceMotion ? nil : .easeIn(duration: 0.15)) { copiedShown = true }
        Haptics.shared.report(.copied)
        copiedCount += 1
    }

    private func menu(for message: ThreadMessage) -> MessageMenuActions? {
        guard message.role != .system, let raw = store.texts[message.contentRef] else { return nil }
        let fromAgent = message.role == .agent
        return MessageMenuActions(
            reply: close == nil ? { startReply(to: message) } : nil,
            copy: { copyToPasteboard(MessageCopy.text(raw, fromAgent: fromAgent)) },
            select: { selecting = SelectableMessage(id: message.messageId, text: raw, fromAgent: fromAgent) }
        )
    }

    private func startReply(to message: ThreadMessage) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { replyingTo = message }
        inputFocused = true
    }

    private func quote(of message: ThreadMessage) -> BubbleQuote {
        BubbleQuote(
            targetId: message.messageId,
            fromAgent: message.role == .agent,
            line: MessageReply.quoteLine(store.texts[message.contentRef] ?? "")
        )
    }

    private func quote(inside raw: String?) -> BubbleQuote? {
        guard let raw, let target = MessageReply.split(raw).replyTo else { return nil }
        guard let original = store.messages(in: threadId).first(where: { $0.messageId == target }),
              original.role != .system,
              store.texts[original.contentRef] != nil
        else { return .missing() }
        return quote(of: original)
    }

    private func codeMenu(for message: ThreadMessage) -> (String) -> MessageMenuActions? {
        let whole = menu(for: message)
        return { code in
            guard let whole else { return nil }
            return MessageMenuActions(reply: whole.reply, copy: { copyToPasteboard(code) }, select: whole.select)
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
            if let close {
                HStack {
                    GlassCircleButton(Text(L.text("chat.back")), action: close) {
                        Icon(.chevronLeft, size: DesignTokens.IconSize.glassButton)
                    }
                    Spacer()
                }
                .padding(.horizontal, DesignTokens.Size.pagePaddingX)
                .frame(height: DesignTokens.Chat.puckSize)
            }
            VStack(spacing: DesignTokens.Chat.puckBannerGap) {
                ChatPuck(busy: avatarBusy, open: openHerPage)
                if let work = shownBackgroundWork {
                    BackgroundWorkCapsule(work: work) { backgroundOpen = true }
                        .transition(reduceMotion ? .identity : .opacity)
                }
            }
        }
        .padding(.top, DesignTokens.Chat.puckTop)
        .frame(maxWidth: .infinity)
        .sheet(isPresented: $backgroundOpen) {
            BackgroundWorkSheet(store: store) { backgroundOpen = false }
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(DesignTokens.Radius.sheetTop)
                .presentationBackground(Color.hmBackground)
        }
    }

    private var shownBackgroundWork: BackgroundWork? {
        guard close == nil, let work = store.backgroundWork, work.showsEntry else { return nil }
        return work
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            transcriptScroll(jump: { target in jump(to: target, with: proxy) })
                .task {
                    guard let scrollToTopAfter, let first = store.transcript(in: threadId).first else { return }
                    try? await Task.sleep(for: .seconds(scrollToTopAfter))
                    withAnimation(.easeInOut(duration: 3)) { proxy.scrollTo(first.id, anchor: .top) }
                }
        }
    }

    private func jump(to messageId: String, with proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) {
            proxy.scrollTo(TranscriptItem.id(ofMessage: messageId), anchor: .center)
        }
        flashing = messageId
        Task {
            try? await Task.sleep(for: .seconds(DesignTokens.Chat.replyFlashSeconds))
            if flashing == messageId {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { flashing = nil }
            }
        }
    }

    private func transcriptScroll(jump: @escaping (String) -> Void) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(store.transcript(in: threadId)) { item in
                    switch item {
                    case let .message(message):
                        Group {
                            if message.role == .agent, let options = message.options {
                                VStack(alignment: .leading, spacing: DesignTokens.Options.afterMessage) {
                                    MessageRow(role: message.role, text: store.texts[message.contentRef], failed: message.status == .failed, codeMenu: codeMenu(for: message), copyCode: copyCode)
                                        .messageMenu(menu(for: message))
                                    MessageOptionsView(options: options, choose: choose(for: message))
                                }
                            } else if message.role == .owner, message.chosenFrom != nil {
                                ChosenOptionBubble(text: store.texts[message.contentRef] ?? "")
                            } else {
                                MessageRow(role: message.role, text: store.texts[message.contentRef], failed: message.status == .failed, codeMenu: codeMenu(for: message), copyCode: copyCode, quote: message.role == .owner ? quote(inside: store.texts[message.contentRef]) : nil, jump: jump)
                                    .messageMenu(menu(for: message))
                            }
                        }
                        .background {
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.bubble, style: .continuous)
                                .fill(Color.hmReplyBar.opacity(flashing == message.messageId ? DesignTokens.Chat.replyFlashOpacity : 0))
                                .padding(-DesignTokens.Chat.replyQuoteGap)
                        }
                        .task(id: message.messageId) {
                            if message.role == .agent, let runId = message.runId { await store.showExecution(runId, in: threadId) }
                        }
                    case let .process(runId):
                        if let line = store.processLine(for: runId, in: threadId) {
                            ProcessRowView(line: line, failed: store.run(runId, in: threadId)?.status == "failed")
                                .task(id: runId) { await store.showExecution(runId, in: threadId) }
                        }
                    }
                }
                if let streaming = store.streamingText(in: threadId) {
                    StreamingAnswer(text: streaming)
                }
                ForEach(store.queuedMessages(in: threadId)) { item in
                    QueuedMessageRow(item: item, online: store.connection == .online, quote: quote(inside: item.message.text)) {
                        Task { await store.retry(item.id) }
                    } discard: {
                        Task { await store.discard(item.id) }
                    }
                }
                if !talkHeard.isEmpty {
                    OwnerBubble(text: talkHeard)
                        .opacity(DesignTokens.Chat.hearingBubbleOpacity)
                }
            }
            .padding(.horizontal, DesignTokens.Size.chatPaddingX)
            .padding(.top, Self.headerHeight + DesignTokens.Chat.puckContentGap + (shownBackgroundWork == nil ? 0 : DesignTokens.Chat.puckBannerGap + DesignTokens.Avatar.backgroundPillHeight))
            .padding(.bottom, 110)
        }
        .defaultScrollAnchor(.bottom, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
    }

    private func copyCode(_ code: String) {
        #if os(iOS)
        Pasteboard.copy(code)
        #endif
    }

    private func choose(for message: ThreadMessage) -> (@MainActor (MessageOptions.Item) async throws -> Void)? {
        guard let chooseOption else { return nil }
        let threadId = threadId
        return { item in try await chooseOption(threadId, message, item) }
    }

    private var stopAction: (() -> Void)? {
        guard let stopRun, !stopping, let run = store.workingRun(in: threadId) else { return nil }
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
        guard let message = store.messages(in: threadId).last(where: { $0.role == .agent }) else { return nil }
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
        guard dictating, let voice else {
            dictation.discardPending()
            deliver(draft, clearDraft: true)
            return
        }
        dictating = false
        let shown = draft
        draft = ""
        Task {
            let text = await dictation.submit(draft: shown) { await voice.finish() }
            deliver(text, clearDraft: true)
        }
    }

    private func deliver(_ text: String, clearDraft: Bool) {
        let carried = attachments
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !carried.isEmpty, !uploading else { return }
        Haptics.shared.report(.messageSent)
        let replyTo = clearDraft ? replyingTo?.messageId : nil
        if clearDraft { replyingTo = nil }
        let text = MessageReply.compose(replyingTo: replyTo, text: text)
        if carried.isEmpty {
            if clearDraft { draft = "" }
            Task { await store.send(text, in: threadId) }
            return
        }
        uploading = true
        Task {
            defer { uploading = false }
            do {
                try await store.send(text, attachments: carried, requestId: sendRequestId, in: threadId)
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
        dictation.begin(draft: draft)
        Task {
            do {
                try await voice.start { text in
                    if let shown = dictation.live(text) { draft = shown }
                }
            } catch {
                dictating = false
            }
        }
    }

    private func stopDictation() {
        guard let voice, dictating else { return }
        dictating = false
        Task {
            if let said = await dictation.stop(finish: { await voice.finish() }) { draft = said }
        }
    }
}

struct MessageRow: View {
    let role: MessageRole
    let text: String?
    let failed: Bool
    var codeMenu: (String) -> MessageMenuActions? = { _ in nil }
    var copyCode: (String) -> Void = { _ in }
    var quote: BubbleQuote?
    var jump: (String) -> Void = { _ in }

    var body: some View {
        switch role {
        case .owner:
            OwnerBubble(text: text ?? "", quote: quote, jump: jump)
        case .agent:
            AnswerText(text: text ?? "", muted: failed, copyCode: copyCode, codeMenu: codeMenu)
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
    var quote: BubbleQuote?
    var jump: (String) -> Void = { _ in }

    var body: some View {
        let shown = MessageAttachments.shown(text)
        HStack {
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: DesignTokens.Chat.listGap) {
                if let quote {
                    if let target = quote.targetId {
                        Button { jump(target) } label: { ReplyQuoteView(quote: quote, lines: 2) }
                            .buttonStyle(.plain)
                            .padding(.bottom, DesignTokens.Chat.listGap)
                    } else {
                        ReplyQuoteView(quote: quote, lines: 2)
                            .padding(.bottom, DesignTokens.Chat.listGap)
                    }
                }
                if !shown.text.isEmpty {
                    Text(shown.text)
                        .hmType(DesignTokens.TypeScale.bubble)
                        #if os(macOS)
                        .textSelection(.enabled)
                        #endif
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

struct QueuedMessageRow: View {
    let item: OutboxItem
    let online: Bool
    var quote: BubbleQuote?
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            OwnerBubble(text: item.message.text, quote: quote)
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
