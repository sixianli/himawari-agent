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
    @Environment(\.chatReadsPhotoLibrary) private var readsPhotoLibrary
    @Environment(\.chatOpensSelectText) private var opensSelectText
    @Environment(\.chatShowsCopied) private var showsCopied
    @Environment(\.chatStartsReplyTo) private var startsReplyTo
    @Environment(\.chatAttachLimits) private var attachLimits
    @Environment(\.chatStopRun) private var stopRun
    @Environment(\.chatChooseOption) private var chooseOption
    @State private var explained: Set<String> = []
    @Environment(\.chatTalk) private var talk
    @Environment(\.chatOwnerAwaited) private var ownerAwaited
    @Environment(\.chatOpensTalk) private var opensTalk
    @State private var talking = false
    @State private var talkStartedAfter: String?
    @State private var stopping = false
    @State private var attachments: [ChatAttachment] = []
    @State private var attachOpen = false
    @State private var attachProblem: String?
    @State private var uploadFailed = false
    @State private var sendRequestId = OutgoingMessage.newId()
    @State private var dictating = false
    @State private var dictation = DictationDraft()
    @State private var selecting: SelectableMessage?
    @State private var shownSteps: ShownSteps?
    @State private var farFromLatest = false
    @State private var latestJumps = 0
    @State private var scrollPosition = ScrollPosition(edge: .bottom)
    @State private var copiedCount = 0
    @State private var copiedShown = false
    @State private var replyingTo: ThreadMessage?
    @State private var flashing: String?
    @State private var backgroundOpen = false
    @State private var screenWidth: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(iOS)
    @State private var safari: SafariLink?
    #endif

    private let explainSpoken: ((ThreadMessage) -> AnyView)?

    public init(
        store: ChatStore,
        threadId: String,
        draft: String = "",
        openHerPage: (() -> Void)? = nil,
        close: (() -> Void)? = nil,
        explainSpoken: ((ThreadMessage) -> AnyView)? = nil
    ) {
        self.store = store
        self.close = close
        self.explainSpoken = explainSpoken
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
            if farFromLatest {
                JumpToLatestButton { latestJumps += 1 }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, DesignTokens.Size.composerInsetX)
                    .padding(.bottom, DesignTokens.Chat.listMarkerGap)
                    .transition(reduceMotion ? .identity : .opacity)
            }
            if copiedShown {
                CopiedToast()
                    .padding(.bottom, DesignTokens.Chat.copiedToastLift)
                    .transition(reduceMotion ? .identity : .opacity)
            }
            #if os(iOS)
            if !attachments.isEmpty {
                AttachmentChips(attachments: attachments, retry: uploadFailed ? { deliver(draft, clearDraft: true) } : nil) { id in
                    attachments.removeAll { $0.id == id }
                    uploadFailed = false
                }
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
            VStack(spacing: DesignTokens.Chat.listMarkerGap) {
                if activeTalk.suggestsVoiceDownload {
                    Text(L.text("chat.talk.voiceHint"))
                        .font(.footnote)
                        .foregroundStyle(Color.hmMuted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
                ChatTalkBar(talk: activeTalk, end: endTalk)
            }
            .transition(.opacity)
        } else {
            ChatInputBar(
                text: $draft,
                focused: $inputFocused,
                sending: uploading,
                hasAttachments: !attachments.isEmpty,
                voice: voice != nil,
                dictating: dictating,
                offline: store.offlineShown,
                openAttach: attachAction,
                stop: stopAction,
                startTalk: talkStarter,
                toggleDictation: toggleDictation,
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
        guard Self.attachAvailable, attachLimits != nil else { return nil }
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
                if opensAttachSheet, attachLimits != nil { attachOpen = true }
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
    @ViewBuilder
    private var attachSheet: some View {
        if let attachLimits {
            AttachSheet(limits: attachLimits, chosen: attachments, readsPhotoLibrary: readsPhotoLibrary) { picked in
                let known = Set(attachments.map(\.id))
                let room = max(0, attachLimits.perMessage - attachments.count)
                let fresh = picked.filter { !known.contains($0.id) }
                attachments += fresh.prefix(room)
                if fresh.count > room { attachProblem = L.format("attach.problem.tooMany", attachLimits.perMessage) }
            } remove: { id in
                attachments.removeAll { $0.id == id }
            } failed: { failure in
                attachProblem = Self.describe(failure)
            } close: {
                attachOpen = false
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
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
            .onChange(of: talk?.running ?? false) { wasRunning, running in
                guard wasRunning, !running, talking else { return }
                withAnimation(.easeInOut(duration: 0.15)) { talking = false }
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
            .sheet(item: $shownSteps) { shown in
                ProcessStepsSheet(steps: shown.steps) { shownSteps = nil }
                    .onAppear { Haptics.shared.report(.sheetSettled) }
                    .presentationDetents([.medium, .large])
                    .presentationCornerRadius(DesignTokens.Radius.sheetTop)
                    .presentationBackground(Color.hmBackground)
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
            select: { selecting = SelectableMessage(id: message.messageId, text: raw, fromAgent: fromAgent) },
            why: explains(message) ? { toggleWhy(message) } : nil,
            steps: finishedSteps(of: message).map { steps in { shownSteps = ShownSteps(id: message.messageId, steps: steps) } }
        )
    }

    private func finishedSteps(of message: ThreadMessage) -> [ProcessStep]? {
        guard message.role == .agent, let runId = message.runId else { return nil }
        return store.processLine(for: runId, in: threadId)?.finishedSteps
    }

    private func explains(_ message: ThreadMessage) -> Bool {
        message.role == .agent && message.spoken && explainSpoken != nil
    }

    private func toggleWhy(_ message: ThreadMessage) {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
            if explained.contains(message.messageId) {
                explained.remove(message.messageId)
            } else {
                explained.insert(message.messageId)
            }
        }
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
            return MessageMenuActions(reply: whole.reply, copy: { copyToPasteboard(code) }, select: whole.select, why: whole.why, steps: whole.steps)
        }
    }

    #if os(iOS)
    private static let attachAvailable = true
    #else
    private static let attachAvailable = false
    #endif

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
                .onChange(of: latestJumps) { _, _ in
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { scrollPosition.scrollTo(edge: .bottom) }
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
        let rows = chatRows
        let placed = BubbleLayout.place(rows.map(\.entry))
        let actions = rowActions(jump: jump)
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    ChatRowView(model: model(of: row, placed: placed[row.id] ?? ChatRow.lone), actions: actions)
                        .equatable()
                }
            }
            .padding(.horizontal, DesignTokens.Chat.bubbleEdge)
            .padding(.top, Self.headerHeight + DesignTokens.Chat.puckContentGap + (shownBackgroundWork == nil ? 0 : DesignTokens.Chat.puckBannerGap + DesignTokens.Avatar.backgroundPillHeight))
            .padding(.bottom, 110)
        }
        .scrollPosition($scrollPosition)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { screenWidth = $0 }
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentSize.height - geometry.visibleRect.maxY > geometry.containerSize.height
        } action: { _, far in
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { farFromLatest = far }
        }
        .defaultScrollAnchor(.bottom, for: .alignment)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
    }

    private var chatRows: [ChatRow] {
        var rows: [ChatRow] = []
        for item in store.transcript(in: threadId) {
            switch item {
            case let .message(message):
                rows.append(.message(message))
            case let .process(runId):
                if let line = store.processLine(for: runId, in: threadId), line.showsInTranscript {
                    rows.append(.process(runId: runId, line: line, failed: store.run(runId, in: threadId)?.status == "failed"))
                }
            }
        }
        if let streaming = store.streamingText(in: threadId) { rows.append(.streaming(streaming)) }
        rows += store.queuedMessages(in: threadId).map(ChatRow.queued)
        if !talkHeard.isEmpty { rows.append(.hearing(talkHeard)) }
        return rows
    }

    private var herWidth: CGFloat {
        screenWidth > 0 ? screenWidth - DesignTokens.Chat.bubbleEdge - DesignTokens.Chat.bubbleHerRoom : .infinity
    }

    private var ownerWidth: CGFloat {
        screenWidth > 0 ? screenWidth * DesignTokens.Chat.bubbleOwnerShare : DesignTokens.Size.bubbleMaxWidth
    }

    private func model(of row: ChatRow, placed: BubblePlacement) -> ChatRowModel {
        var text: String?
        var quote: BubbleQuote?
        var flashes = false
        var why = ChatRowWhy.none
        switch row {
        case let .message(message):
            text = store.texts[message.contentRef]
            if explains(message) { why = explained.contains(message.messageId) ? .open : .closed }
            if message.role == .owner, message.chosenFrom == nil { quote = self.quote(inside: text) }
            flashes = flashing == message.messageId
        case let .queued(item):
            quote = self.quote(inside: item.message.text)
        default:
            break
        }
        return ChatRowModel(row: row, text: text, quote: quote, placement: placed, herWidth: herWidth, ownerWidth: ownerWidth, flashing: flashes, online: store.connection == .online, why: why)
    }

    private func rowActions(jump: @escaping (String) -> Void) -> ChatRowActions {
        ChatRowActions(
            menu: { menu(for: $0) },
            codeMenu: { codeMenu(for: $0) },
            copyCode: copyCode,
            choose: { choose(for: $0) },
            jump: jump,
            retry: { id in Task { await store.retry(id) } },
            discard: { id in Task { await store.discard(id) } },
            showExecution: { [store, threadId] runId in await store.showExecution(runId, in: threadId) },
            toggleWhy: { toggleWhy($0) },
            explanation: { [explainSpoken] message in explainSpoken?(message) }
        )
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
                try await talk.begin { said, messageId in deliver(said, clearDraft: false, spoken: true, messageId: messageId) }
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

    private func deliver(_ text: String, clearDraft: Bool, spoken: Bool = false, messageId: String = OutgoingMessage.newId()) {
        let carried = attachments
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !carried.isEmpty, !uploading else { return }
        Haptics.shared.report(.messageSent)
        let replyTo = clearDraft ? replyingTo?.messageId : nil
        if clearDraft { replyingTo = nil }
        let text = MessageReply.compose(replyingTo: replyTo, text: text)
        if carried.isEmpty {
            if clearDraft { draft = "" }
            Task { await store.send(text, in: threadId, spoken: spoken, messageId: messageId) }
            return
        }
        uploading = true
        Task {
            defer { uploading = false }
            do {
                try await store.send(text, attachments: carried, requestId: sendRequestId, in: threadId, spoken: spoken, messageId: messageId)
                attachments.removeAll { item in carried.contains { $0.id == item.id } }
                sendRequestId = OutgoingMessage.newId()
                uploadFailed = false
                if clearDraft { draft = "" }
            } catch let problem as ChatAttachmentProblem {
                uploadFailed = problem == .uploadFailed
                attachProblem = Self.describe(problem)
            } catch {
                uploadFailed = true
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
        case .imagesUnsupported: L.text("attach.problem.images")
        }
    }

    #if os(iOS)
    static func describe(_ failure: AttachFailure) -> String {
        switch failure {
        case .noLocation: L.text("attach.problem.location")
        case .tooLarge: L.format("attach.problem.fileTooLarge", ChatAttachmentPlanner.maxFileBytes / ChatAttachmentPlanner.bytesPerMegabyte)
        case .unreadable: L.text("attach.problem.unreadable")
        case .imagesUnsupported: L.text("attach.problem.images")
        }
    }
    #endif

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

struct ChatRowModel: Equatable {
    let row: ChatRow
    let text: String?
    let quote: BubbleQuote?
    let placement: BubblePlacement
    let herWidth: CGFloat
    let ownerWidth: CGFloat
    let flashing: Bool
    let online: Bool
    let why: ChatRowWhy
}

enum ChatRowWhy: Equatable {
    case none
    case closed
    case open
}

struct ChatRowActions {
    let menu: (ThreadMessage) -> MessageMenuActions?
    let codeMenu: (ThreadMessage) -> (String) -> MessageMenuActions?
    let copyCode: (String) -> Void
    let choose: (ThreadMessage) -> (@MainActor (MessageOptions.Item) async throws -> Void)?
    let jump: (String) -> Void
    let retry: (String) -> Void
    let discard: (String) -> Void
    let showExecution: (String) async -> Void
    let toggleWhy: (ThreadMessage) -> Void
    let explanation: (ThreadMessage) -> AnyView?
}

struct ChatRowView: View, @MainActor Equatable {
    let model: ChatRowModel
    let actions: ChatRowActions

    static func == (lhs: ChatRowView, rhs: ChatRowView) -> Bool {
        lhs.model == rhs.model
    }

    var body: some View {
        VStack(spacing: 0) {
            if let time = model.placement.timeAbove {
                BubbleTimeLine(date: time)
            }
            content
        }
        .padding(.top, Self.gap(model.placement.gapAbove))
    }

    private static func gap(_ gap: BubbleGap) -> CGFloat {
        switch gap {
        case .none: 0
        case .inGroup: DesignTokens.Chat.bubbleGroupGap
        case .newSpeaker: DesignTokens.Chat.bubbleSpeakerGap
        case .aroundStep: DesignTokens.Chat.bubbleStepGap
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.row {
        case let .message(message):
            messageRow(message)
                .background {
                    RoundedRectangle(cornerRadius: DesignTokens.Chat.bubbleRadius, style: .continuous)
                        .fill(Color.hmReplyBar.opacity(model.flashing ? DesignTokens.Chat.replyFlashOpacity : 0))
                        .padding(-DesignTokens.Chat.replyQuoteGap)
                }
                .task(id: message.messageId) {
                    if message.role == .agent, let runId = message.runId { await actions.showExecution(runId) }
                }
        case let .process(runId, line, failed):
            ProcessRowView(line: line, failed: failed)
                .task(id: runId) { await actions.showExecution(runId) }
        case let .streaming(text):
            HerBubble(text: text, streaming: true, maxWidth: model.herWidth)
        case let .queued(item):
            QueuedMessageRow(item: item, online: model.online, quote: model.quote, maxWidth: model.ownerWidth) {
                actions.retry(item.id)
            } discard: {
                actions.discard(item.id)
            }
        case let .hearing(text):
            OwnerBubble(text: text, maxWidth: model.ownerWidth)
                .opacity(DesignTokens.Chat.hearingBubbleOpacity)
        }
    }

    @ViewBuilder
    private func messageRow(_ message: ThreadMessage) -> some View {
        let text = model.text ?? ""
        switch message.role {
        case .agent:
            VStack(alignment: .leading, spacing: DesignTokens.Options.afterMessage) {
                HerBubble(text: text, failed: message.status == .failed, maxWidth: model.herWidth, copyCode: actions.copyCode, codeMenu: actions.codeMenu(message), menu: actions.menu(message))
                if let options = message.options {
                    MessageOptionsView(options: options, choose: actions.choose(message))
                }
                if model.why != .none {
                    why(message)
                }
            }
        case .owner where message.chosenFrom != nil:
            ChosenOptionBubble(text: text, maxWidth: model.ownerWidth)
        case .owner:
            OwnerBubble(text: text, quote: model.quote, jump: actions.jump, maxWidth: model.ownerWidth, menu: actions.menu(message))
        case .system:
            Text(text)
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

extension ChatRowView {
    @ViewBuilder
    fileprivate func why(_ message: ThreadMessage) -> some View {
        let open = model.why == .open
        Button {
            actions.toggleWhy(message)
        } label: {
            Label(L.text(open ? "chat.why.hide" : "chat.why"), systemImage: "questionmark.circle")
                .font(.subheadline)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .tint(Color.hmSun)
        .accessibilityValue(L.text(open ? "chat.why.open" : "chat.why.closed"))
        if open, let explanation = actions.explanation(message) {
            explanation
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }
}

enum ChatRow: Identifiable, Equatable {
    case message(ThreadMessage)
    case process(runId: String, line: ProcessLine, failed: Bool)
    case streaming(String)
    case queued(OutboxItem)
    case hearing(String)

    static let lone = BubblePlacement(timeAbove: nil, gapAbove: .newSpeaker)

    var id: String {
        switch self {
        case let .message(message): TranscriptItem.id(ofMessage: message.messageId)
        case let .process(runId, _, _): "process:\(runId)"
        case .streaming: "streaming"
        case let .queued(item): "queued:\(item.id)"
        case .hearing: "hearing"
        }
    }

    var entry: BubbleEntry {
        switch self {
        case let .message(message):
            let speaker: BubbleSpeaker = switch message.role {
            case .agent: .her
            case .owner: .owner
            case .system: .other
            }
            return BubbleEntry(id: id, speaker: speaker, at: BubbleDates.date(message.committedAt))
        case .process:
            return .step(id: id)
        case .streaming:
            return BubbleEntry(id: id, speaker: .her, at: nil)
        case .queued, .hearing:
            return BubbleEntry(id: id, speaker: .owner, at: nil)
        }
    }
}

struct HerBubble: View {
    let text: String
    var streaming = false
    var failed = false
    let maxWidth: CGFloat
    var copyCode: (String) -> Void = { _ in }
    var codeMenu: (String) -> MessageMenuActions? = { _ in nil }
    var menu: MessageMenuActions?

    var body: some View {
        AnswerText(text: text, streaming: streaming, muted: failed, copyCode: copyCode, codeMenu: codeMenu)
            .bubble(.her, menu: menu)
            .frame(maxWidth: maxWidth, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text(L.text("chat.bubble.her")))
    }
}

struct OwnerBubble: View {
    let text: String
    var quote: BubbleQuote?
    var jump: (String) -> Void = { _ in }
    var maxWidth: CGFloat = DesignTokens.Size.bubbleMaxWidth
    var menu: MessageMenuActions?

    var body: some View {
        let shown = MessageAttachments.shown(text)
        VStack(alignment: .trailing, spacing: DesignTokens.Chat.listGap) {
            ForEach(Array(shown.attachments.enumerated()), id: \.offset) { _, attachment in
                Label {
                    Text(attachment.name).hmType(DesignTokens.TypeScale.secondary)
                } icon: {
                    Icon(attachment.kind == .image ? .photo : .fileText, size: DesignTokens.Chat.attachRowIcon)
                }
                .foregroundStyle(Color.hmMuted)
            }
            if quote != nil || !shown.text.isEmpty {
                VStack(alignment: .leading, spacing: DesignTokens.Chat.listGap) {
                    if let quote {
                        if let target = quote.targetId {
                            Button { jump(target) } label: { ReplyQuoteView(quote: quote, lines: 2, onInk: true) }
                                .buttonStyle(.pressable)
                                .padding(.bottom, DesignTokens.Chat.listGap)
                        } else {
                            ReplyQuoteView(quote: quote, lines: 2, onInk: true)
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
                }
                .foregroundStyle(Color.hmOnBubbleOwner)
                .tint(Color.hmOnBubbleOwner)
                .bubble(.owner, menu: menu)
                .frame(maxWidth: maxWidth, alignment: .trailing)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(L.text("chat.bubble.owner")))
    }
}

struct QueuedMessageRow: View {
    let item: OutboxItem
    let online: Bool
    var quote: BubbleQuote?
    var maxWidth: CGFloat = DesignTokens.Size.bubbleMaxWidth
    let retry: () -> Void
    let discard: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            OwnerBubble(text: item.message.text, quote: quote, maxWidth: maxWidth)
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
                        Button(action: retry) {
                            Text(L.text("chat.queued.retryNow"))
                                .fontWeight(.semibold)
                                .foregroundStyle(Color.hmSun)
                                .frame(minWidth: DesignTokens.Size.minTapTarget, minHeight: DesignTokens.Size.minTapTarget)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.pressable)
                    }
                case .waiting, .sending:
                    Text(L.text("chat.queued.sending"))
                        .foregroundStyle(Color.hmMuted)
                }
            }
            .hmType(DesignTokens.TypeScale.caption)
            .buttonStyle(.pressable)
            .frame(minHeight: DesignTokens.Size.minTapTarget)
            .contentShape(Rectangle())
            .padding(.vertical, -(DesignTokens.Size.minTapTarget - (DesignTokens.TypeScale.caption.lineHeight ?? DesignTokens.Size.minTapTarget)) / 2)
            .padding(.trailing, 6)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
