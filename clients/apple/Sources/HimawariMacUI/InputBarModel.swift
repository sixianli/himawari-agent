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
        draft = ""
        problem = nil
        threadId = nil
        pendingRequestId = nil
        pieces = ContextGathering.pieces(from: snapshot, seesFrontmost: seesFrontmost, labels: Self.labels, readFile: ContextReader.read)
    }

    func add(files urls: [URL]) {
        let added = urls.filter(\.isFileURL).map { ContextGathering.filePiece($0, source: .droppedFile, reading: ContextReader.read($0)) }
        pieces = ContextGathering.merge(pieces, adding: added)
        problem = nil
    }

    func remove(_ pieceId: String) {
        pieces.removeAll { $0.id == pieceId }
        if problem == .tooMany { problem = nil }
    }

    var canSend: Bool {
        !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
        Task {
            defer { sending = false }
            var attachments: [MessageAttachment] = []
            if let limits, !carried.isEmpty {
                do {
                    attachments = try await api.attach(carried, requestId: requestId, limits: limits)
                } catch {
                    problem = .uploadFailed
                    return
                }
                guard MessageAttachments.fits(text: text, attachments: attachments, limits: limits) else {
                    problem = .tooMany
                    return
                }
            }
            guard let chat = chat() else {
                problem = .sendFailed
                return
            }
            do {
                let thread: String
                if let threadId {
                    thread = threadId
                } else {
                    thread = try await chat.newThread(requestId: requestId)
                    threadId = thread
                    chat.watch(thread)
                }
                await chat.send(MessageAttachments.compose(text: text, attachments: attachments), in: thread)
                draft = ""
                pieces = []
                pendingRequestId = nil
            } catch {
                problem = .sendFailed
            }
        }
    }

    func close() {
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
