#if os(macOS)
import AppKit
import Foundation
import HimawariChat
import HimawariCore
import Observation

@MainActor
@Observable
final class InputBarModel {
    enum Problem: Equatable {
        case tooMany
        case attachmentsUnsupported
        case uploadFailed
        case sendFailed
    }

    var draft = ""
    private(set) var pieces: [ContextPiece] = []
    private(set) var sending = false
    private(set) var problem: Problem?
    private(set) var threadId: String?
    @ObservationIgnored private let api: DeviceAPI
    @ObservationIgnored private let chat: () -> ChatStore?
    @ObservationIgnored private let limits: () -> AttachmentLimits?
    @ObservationIgnored private var pendingRequestId: String?
    @ObservationIgnored private var session = 0

    init(api: DeviceAPI, chat: @escaping () -> ChatStore?, limits: @escaping () -> AttachmentLimits?) {
        self.api = api
        self.chat = chat
        self.limits = limits
    }

    static let labels = ContextLabels(
        frontApp: { L.format("input.frontApp", $0.name) },
        selection: { L.format("input.selection", $0) }
    )

    func begin(with snapshot: ContextSnapshot, seesFrontmost: Bool) {
        session += 1
        sending = false
        draft = ""
        problem = nil
        threadId = nil
        pendingRequestId = nil
        pieces = ContextGathering.pieces(from: snapshot, seesFrontmost: seesFrontmost, labels: Self.labels, readFile: ContextReader.read)
    }

    func add(files urls: [URL]) {
        let files = urls.filter(\.isFileURL)
        guard !files.isEmpty else { return }
        let started = session
        Task {
            let added = await Task.detached(priority: .userInitiated) {
                files.map { ContextGathering.filePiece($0, source: .droppedFile, reading: ContextReader.read($0)) }
            }.value
            guard started == session else { return }
            add(pieces: added)
        }
    }

    func add(pieces added: [ContextPiece]) {
        let merged = ContextGathering.merge(pieces, adding: added, limit: limits()?.perMessage)
        if merged.pieces != pieces { pendingRequestId = nil }
        pieces = merged.pieces
        problem = merged.overflowed ? .tooMany : nil
    }

    func remove(_ pieceId: String) {
        pieces.removeAll { $0.id == pieceId }
        pendingRequestId = nil
        if problem == .tooMany { problem = nil }
    }

    var canSend: Bool {
        !sending && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pieces.isEmpty)
    }

    func send() {
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let limits = limits()
        if !pieces.isEmpty {
            guard let limits else {
                problem = .attachmentsUnsupported
                return
            }
            guard pieces.count <= limits.perMessage else {
                problem = .tooMany
                return
            }
        }
        sending = true
        problem = nil
        let requestId = pendingRequestId ?? OutgoingMessage.newId()
        pendingRequestId = requestId
        let carried = pieces
        let started = session
        Task {
            let outcome = await deliver(text: text, carried: carried, requestId: requestId, limits: limits, session: started)
            guard started == session else { return }
            sending = false
            switch outcome {
            case .sent:
                draft = ""
                pieces = []
                pendingRequestId = nil
            case let .failed(failure):
                problem = failure
            }
        }
    }

    private enum Delivery {
        case sent
        case failed(Problem)
    }

    private func deliver(text: String, carried: [ContextPiece], requestId: String, limits: AttachmentLimits?, session started: Int) async -> Delivery {
        var attachments: [MessageAttachment] = []
        if let limits, !carried.isEmpty {
            do {
                attachments = try await api.attach(carried, requestId: requestId, limits: limits)
            } catch {
                return .failed(.uploadFailed)
            }
            guard MessageAttachments.fits(text: text, attachments: attachments, limits: limits) else { return .failed(.tooMany) }
        }
        guard started == session, let chat = chat() else { return .failed(.sendFailed) }
        do {
            let thread: String
            if let threadId {
                thread = threadId
            } else {
                thread = try await chat.newThread(requestId: requestId)
                guard started == session else { return .failed(.sendFailed) }
                threadId = thread
                chat.watch(thread)
            }
            await chat.send(MessageAttachments.compose(text: text, attachments: attachments), in: thread)
            return .sent
        } catch {
            return .failed(.sendFailed)
        }
    }

    func close() {
        session += 1
        sending = false
        if threadId != nil { chat()?.unwatch() }
    }

    @ObservationIgnored private var previewAnswer: String?

    func preview(threadId: String, answer: String) {
        self.threadId = threadId
        previewAnswer = answer
    }

    var answer: String? {
        if let previewAnswer { return previewAnswer }
        guard let threadId, let chat = chat() else { return nil }
        if let streaming = chat.streamingText(in: threadId), !streaming.isEmpty { return streaming }
        guard let last = chat.messages(in: threadId).last(where: { $0.role == .agent }) else { return nil }
        return chat.texts[last.contentRef]
    }

    var runningProcess: ProcessLine? {
        guard let threadId, let chat = chat() else { return nil }
        guard let run = chat.details[threadId]?.runs.last(where: { !ProcessLine.terminalRunStatuses.contains($0.status) }) else { return nil }
        return chat.processLine(for: run.runId, in: threadId)
    }

    var queuedOffline: Bool {
        guard let threadId, let chat = chat() else { return false }
        return !chat.queuedMessages(in: threadId).isEmpty && chat.connection != .online
    }
}
#endif
