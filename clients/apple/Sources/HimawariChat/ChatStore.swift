import Foundation
import HimawariCore
import Observation

public enum TranscriptItem: Identifiable, Equatable {
    case message(ThreadMessage)
    case process(runId: String)

    public static func id(ofMessage messageId: String) -> String {
        "message:\(messageId)"
    }

    public var id: String {
        switch self {
        case let .message(message): Self.id(ofMessage: message.messageId)
        case let .process(runId): "process:\(runId)"
        }
    }
}

public enum ChatConnection: Sendable, Equatable {
    case offline
    case connecting
    case online
}

@MainActor
@Observable
public final class ChatStore {
    public internal(set) var threads: [ThreadSummary] = []
    public internal(set) var texts: [String: String] = [:]
    public internal(set) var details: [String: ThreadDetail] = [:]
    public internal(set) var queued: [OutboxItem] = []
    public internal(set) var streaming: [String: StreamingReply] = [:]
    public internal(set) var connection: ChatConnection = .offline {
        didSet { notice?.connectionChanged(online: connection == .online) }
    }
    public internal(set) var offlineShown = false
    public private(set) var loadingThreads = false
    public internal(set) var executions: [String: [ExecutionRecord]] = [:]
    public internal(set) var backgroundWork: BackgroundWork?

    @ObservationIgnored private let api: DeviceAPI
    @ObservationIgnored private let outbox: Outbox
    @ObservationIgnored private let cache: ThreadCache
    @ObservationIgnored private let events: DeviceEventStream
    @ObservationIgnored private let onSessionInvalid: @MainActor () -> Void
    @ObservationIgnored private let onDeviceActions: @MainActor () -> Void
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private var flushing = false
    @ObservationIgnored private var flushAgain = false
    @ObservationIgnored var frozen = false
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var retryFailures = 0
    @ObservationIgnored private var createdRevisions: [String: Int] = [:]
    @ObservationIgnored private var pendingTextRefs: Set<String> = []
    @ObservationIgnored private var executionLoads = ReloadGate<String>()
    @ObservationIgnored private var backgroundLoads = ReloadGate<String>()
    @ObservationIgnored private let heartbeatSeconds: @Sendable () -> TimeInterval
    @ObservationIgnored private var watched: (threadId: String, stream: DeviceEventStream, task: Task<Void, Never>)?
    @ObservationIgnored private let answerLocale: AnswerLocale
    @ObservationIgnored private let images: ImageFitting?
    @ObservationIgnored private var wantedThreadId: String?
    @ObservationIgnored private var streamConnections: Int?
    @ObservationIgnored private var notice: OfflineNotice?
    @ObservationIgnored private var networkWatch: NetworkChangeWatch?
    @ObservationIgnored public var onNotification: (@MainActor (DeviceStreamEvent) -> Void)?

    public init(
        api: DeviceAPI,
        store: LocalStore,
        heartbeatSeconds: @escaping @Sendable () -> TimeInterval,
        answerLocale: AnswerLocale = .matching(preferredLanguages: Locale.preferredLanguages),
        onSessionInvalid: @escaping @MainActor () -> Void,
        onDeviceActions: @escaping @MainActor () -> Void = {},
        images: ImageFitting? = nil
    ) {
        self.api = api
        self.images = images
        self.heartbeatSeconds = heartbeatSeconds
        self.answerLocale = answerLocale
        outbox = Outbox(store: store)
        cache = ThreadCache(store: store)
        events = DeviceEventStream(http: api.http, cursors: StoredCursor(store: store), heartbeat: heartbeatSeconds)
        self.onSessionInvalid = onSessionInvalid
        self.onDeviceActions = onDeviceActions
        let snapshot = cache.load()
        threads = snapshot.threads
        texts = snapshot.texts
        details = snapshot.details
        notice = OfflineNotice { [weak self] shown in self?.offlineShown = shown }
    }

    public func start() {
        guard !frozen else { return }
        stop()
        tasks.append(Task { [weak self] in
            guard let self else { return }
            for await items in await outbox.updates() {
                queued = items
            }
        })
        tasks.append(Task { [weak self] in
            guard let self else { return }
            connection = .connecting
            for await event in events.start() {
                await handle(event)
            }
            connection = .offline
        })
        networkWatch = NetworkChangeWatch { [weak self] in self?.restartConnections() }
        Task { await refreshThreads() }
    }

    public func stop() {
        networkWatch = nil
        retryTask?.cancel()
        retryTask = nil
        tasks.forEach { $0.cancel() }
        tasks.removeAll()
        events.stop()
        unwatch()
    }

    public func limitStreams(to connections: Int?) {
        streamConnections = connections
        if !ExecutionStreamPolicy.allowed(streamConnections: connections) {
            closeWatchedStream()
        } else if let wantedThreadId {
            watch(wantedThreadId)
        }
    }

    public func watch(_ threadId: String) {
        guard !frozen else { return }
        wantedThreadId = threadId
        guard ExecutionStreamPolicy.allowed(streamConnections: streamConnections) else {
            if let streamConnections { StreamDiagnostics.shared.note(.notOpened(path: "threads/\(threadId)/execution-stream", streamConnections: streamConnections)) }
            return
        }
        if watched?.threadId == threadId { return }
        closeWatchedStream()
        let stream = DeviceEventStream(http: api.http, path: "threads/\(threadId)/execution-stream", cursors: nil, heartbeat: heartbeatSeconds)
        let task = Task { [weak self] in
            for await event in stream.start() {
                guard let self else { return }
                await self.handle(event)
            }
        }
        watched = (threadId, stream, task)
    }

    public func unwatch() {
        wantedThreadId = nil
        closeWatchedStream()
    }

    private func closeWatchedStream() {
        watched?.task.cancel()
        watched?.stream.stop()
        watched = nil
    }

    public func reconnect() {
        guard !frozen else { return }
        restartConnections()
        Task { await flush() }
    }

    private func restartConnections() {
        notice?.retrying()
        events.restartConnection()
        watched?.stream.restartConnection()
    }

    public func title(for thread: ThreadSummary) -> String? {
        thread.titleRef.flatMap { texts[$0] }
    }

    public func messages(in threadId: String) -> [ThreadMessage] {
        details[threadId]?.messages ?? []
    }

    public func queuedMessages(in threadId: String) -> [OutboxItem] {
        queued.filter { $0.message.threadId == threadId }
    }

    public func isBusy(in threadId: String) -> Bool {
        streaming[threadId].map { !$0.isSettled(in: details[threadId]) } ?? false || (details[threadId]?.runs ?? []).contains(where: \.isWorking)
    }

    public func workingRun(in threadId: String) -> ThreadRunSummary? {
        details[threadId]?.runs.last(where: \.isWorking)
    }

    public func streamingText(in threadId: String) -> String? {
        guard let reply = streaming[threadId], !reply.isSettled(in: details[threadId]) else { return nil }
        let text = reply.text
        return text.isEmpty ? nil : text
    }

    public func refreshThreads() async {
        guard !frozen else { return }
        loadingThreads = true
        defer { loadingThreads = false }
        do {
            var collected: [ThreadSummary] = []
            var cursor: String?
            var seen = Set<String>()
            repeat {
                let page = try await api.threads(after: cursor)
                collected += page.threads
                cursor = page.nextCursor
                if let cursor, !seen.insert(cursor).inserted { throw DeviceAPIError.invalidResponse }
            } while cursor != nil
            threads = collected.sorted(by: Self.listOrder)
            await loadTexts(threads.compactMap(\.titleRef))
            persist()
        } catch {
            await handle(error)
        }
    }

    public func load(_ threadId: String) async {
        guard !frozen else { return }
        do {
            let detail = try await api.fullThread(threadId)
            details[threadId] = detail
            if let index = threads.firstIndex(where: { $0.threadId == threadId }) {
                threads[index] = detail.thread
            }
            await loadTexts(detail.messages.map(\.contentRef) + [detail.thread.titleRef].compactMap { $0 })
            if let reply = streaming[threadId], reply.isSettled(in: detail) || detail.runs.allSatisfy({ ProcessLine.terminalRunStatuses.contains($0.status) }) {
                streaming[threadId] = nil
            }
            persist()
        } catch {
            await handle(error)
        }
    }

    public func run(_ runId: String, in threadId: String) -> ThreadRunSummary? {
        details[threadId]?.runs.first { $0.runId == runId }
    }

    public func processLine(for runId: String, in threadId: String) -> ProcessLine? {
        guard let run = run(runId, in: threadId) else { return nil }
        let records = executions[runId]
        let line = ProcessLine.make(records: records ?? [], runStatus: run.status)
        if ProcessLine.terminalRunStatuses.contains(run.status) && records == nil { return nil }
        return line.hasNothingToShow ? nil : line
    }

    public func transcript(in threadId: String) -> [TranscriptItem] {
        let messages = messages(in: threadId)
        let runs = details[threadId]?.runs ?? []
        var shown = Set<String>()
        var items: [TranscriptItem] = []
        for message in messages {
            if message.role == .agent, let runId = message.runId, !shown.contains(runId), runs.contains(where: { $0.runId == runId }) {
                shown.insert(runId)
                items.append(.process(runId: runId))
            }
            items.append(.message(message))
        }
        for run in runs where !shown.contains(run.runId) && !ProcessLine.terminalRunStatuses.contains(run.status) {
            items.append(.process(runId: run.runId))
        }
        return items
    }

    public func showExecution(_ runId: String, in threadId: String) async {
        guard ExecutionRefresh.needed(loaded: executions[runId] != nil, runStatus: run(runId, in: threadId)?.status) else { return }
        await loadExecution(runId, in: threadId)
    }

    public func loadExecution(_ runId: String, in threadId: String) async {
        guard !frozen else { return }
        guard executionLoads.begin(runId) else { return }
        while true {
            do {
                let records = try await api.executionRecords(threadId: threadId, runId: runId, known: executions[runId] ?? [])
                if executions[runId] != records { executions[runId] = records }
            } catch {
                executionLoads.cancel(runId)
                await handle(error)
                return
            }
            if frozen {
                executionLoads.cancel(runId)
                return
            }
            if !executionLoads.finish(runId) { return }
        }
    }

    public func refreshBackgroundWork() async {
        guard !frozen else { return }
        guard backgroundLoads.begin("work") else { return }
        while true {
            do {
                backgroundWork = try await api.backgroundWork()
            } catch {
                backgroundLoads.cancel("work")
                return
            }
            if frozen {
                backgroundLoads.cancel("work")
                return
            }
            if !backgroundLoads.finish("work") { return }
        }
    }

    public func prefetch(_ threadId: String) {
        guard !frozen else { return }
        guard details[threadId] == nil else { return }
        Task { await load(threadId) }
    }

    public func newThread(requestId: String) async throws -> String {
        let created: CreatedThread
        do {
            created = try await api.createThread(requestId: requestId, answerLocale: answerLocale)
        } catch {
            await handle(error)
            throw error
        }
        createdRevisions[created.threadId] = created.threadRevision
        await refreshThreads()
        return created.threadId
    }

    public func send(_ text: String, in threadId: String) async {
        guard !frozen else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let revision = details[threadId]?.thread.revision ?? threads.first(where: { $0.threadId == threadId })?.revision ?? createdRevisions[threadId] ?? 1
        await outbox.enqueue(OutgoingMessage(threadId: threadId, expectedRevision: revision, text: trimmed, createdAt: Date()))
        await flush()
    }

    public func send(_ text: String, attachments: [ChatAttachment], requestId: String, in threadId: String) async throws {
        guard !attachments.isEmpty else {
            await send(text, in: threadId)
            return
        }
        let composed = try await api.compose(
            text: text.trimmingCharacters(in: .whitespacesAndNewlines),
            attachments: attachments,
            requestId: requestId,
            images: images
        )
        await send(composed, in: threadId)
    }

    public func retry(_ messageId: String) async {
        await outbox.retry(messageId)
        if connection != .online { events.reconnectNow() }
        await flush()
    }

    public func discard(_ messageId: String) async {
        await outbox.discard(messageId)
    }

    func flush() async {
        guard !frozen else { return }
        guard !flushing else {
            flushAgain = true
            return
        }
        flushing = true
        defer { flushing = false }
        while true {
            flushAgain = false
            let results = await outbox.flush(using: api) { [weak self] threadId in
                await self?.details[threadId]?.thread.revision
            }
            let deferred = results.contains(.retryLater)
            if results.contains(where: { $0.deviceRevoked }) {
                onSessionInvalid()
                return
            }
            if deferred {
                scheduleRetry()
            } else {
                retryFailures = 0
                retryTask?.cancel()
                retryTask = nil
            }
            if results.contains(where: { if case .delivered = $0 { true } else { false } }) {
                await refreshThreads()
            }
            if deferred || !flushAgain { return }
        }
    }

    private func scheduleRetry() {
        retryFailures += 1
        let delay = Self.retryDelay(failures: retryFailures)
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            await self.flush()
        }
    }

    static func retryDelay(failures: Int) -> Double {
        min(60, 2 * pow(2, Double(max(0, failures - 1))))
    }

    private func handle(_ event: DeviceStreamEvent) async {
        switch event {
        case .connected:
            connection = .online
            onDeviceActions()
            await flush()
            await refreshBackgroundWork()
        case .deviceActions:
            onDeviceActions()
        case .disconnected:
            connection = .connecting
        case let .thread(threadEvent):
            if details[threadEvent.threadId] != nil {
                await load(threadEvent.threadId)
            }
            await refreshThreads()
            await refreshBackgroundWork()
        case let .executionText(chunk):
            guard !StreamingReply(runId: chunk.runId).isSettled(in: details[chunk.threadId]) else { break }
            var reply = streaming[chunk.threadId].flatMap { $0.runId == chunk.runId ? $0 : nil } ?? StreamingReply(runId: chunk.runId)
            reply.apply(chunk)
            streaming[chunk.threadId] = reply
        case let .executionChanged(threadId, runId):
            if details[threadId] != nil {
                await load(threadId)
                await loadExecution(runId, in: threadId)
            } else if executions[runId] != nil {
                await loadExecution(runId, in: threadId)
            }
            await refreshBackgroundWork()
        case .notificationDeliver, .notificationWithdraw:
            onNotification?(event)
        case .unavailable:
            break
        case .resyncRequired:
            await refreshThreads()
            for threadId in details.keys { await load(threadId) }
            await refreshBackgroundWork()
        case .sessionInvalid:
            connection = .offline
            onSessionInvalid()
        }
    }

    private func handle(_ error: Error) async {
        if let error = error as? DeviceAPIError, error.isRevoked {
            onSessionInvalid()
        }
    }

    private func loadTexts(_ refs: [String]) async {
        let missing = Array(Set(refs).subtracting(texts.keys).subtracting(pendingTextRefs)).sorted()
        guard !missing.isEmpty else { return }
        pendingTextRefs.formUnion(missing)
        defer { pendingTextRefs.subtract(missing) }
        do {
            let resolved = try await api.texts(for: missing)
            texts.merge(resolved) { _, new in new }
        } catch {
            await handle(error)
        }
    }

    private func persist() {
        cache.save(ThreadCacheSnapshot(threads: threads, texts: texts, details: details))
    }

    static func listOrder(_ left: ThreadSummary, _ right: ThreadSummary) -> Bool {
        switch (left.pinOrder, right.pinOrder) {
        case let (l?, r?): return l < r
        case (_?, nil): return true
        case (nil, _?): return false
        default:
            if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
            return left.threadId < right.threadId
        }
    }
}
