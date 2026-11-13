#if os(macOS)
import AppKit
import Foundation
import HimawariChat
import HimawariCore
import Observation

@MainActor
@Observable
public final class InputBarModel {
    public enum Problem: Equatable {
        case tooMany
        case uploadFailed
        case sendFailed
    }

    public var draft = ""
    public private(set) var pieces: [ContextPiece] = []
    public private(set) var sending = false
    public private(set) var problem: Problem?
    public private(set) var threadId: String?
    @ObservationIgnored private let api: DeviceAPI
    @ObservationIgnored private let chat: () -> ChatStore?
    @ObservationIgnored private var pendingRequestId: String?

    public init(api: DeviceAPI, chat: @escaping () -> ChatStore?) {
        self.api = api
        self.chat = chat
    }

    public static let labels = ContextLabels(
        frontApp: { L.format("input.frontApp", $0.name) },
        selection: { L.format("input.selection", $0) }
    )

    public func begin(with snapshot: ContextSnapshot, seesFrontmost: Bool) {
        draft = ""
        problem = nil
        threadId = nil
        pendingRequestId = nil
        pieces = ContextGathering.pieces(from: snapshot, seesFrontmost: seesFrontmost, labels: Self.labels, readFile: ContextReader.read)
    }

    public func add(files urls: [URL]) {
        let added = urls.filter(\.isFileURL).map { ContextGathering.filePiece($0, source: .droppedFile, reading: ContextReader.read($0)) }
        pieces = ContextGathering.merge(pieces, adding: added)
        problem = nil
    }

    public func remove(_ pieceId: String) {
        pieces.removeAll { $0.id == pieceId }
        if problem == .tooMany { problem = nil }
    }

    public var canSend: Bool {
        !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func send() {
        guard canSend else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard pieces.count <= MessageAttachments.maximumCount else {
            problem = .tooMany
            return
        }
        sending = true
        problem = nil
        let requestId = pendingRequestId ?? OutgoingMessage.newId()
        pendingRequestId = requestId
        let carried = pieces
        Task {
            defer { sending = false }
            let attachments: [MessageAttachment]
            do {
                attachments = try await api.attach(carried, requestId: requestId)
            } catch {
                problem = .uploadFailed
                return
            }
            guard MessageAttachments.fits(text: text, attachments: attachments) else {
                problem = .tooMany
                return
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

    public func close() {
        if threadId != nil { chat()?.unwatch() }
    }

    public var answer: String? {
        guard let threadId, let chat = chat() else { return nil }
        if let streaming = chat.streamingText(in: threadId), !streaming.isEmpty { return streaming }
        guard let last = chat.messages(in: threadId).last(where: { $0.role == .agent }) else { return nil }
        return chat.texts[last.contentRef]
    }

    public var runningProcess: ProcessLine? {
        guard let threadId, let chat = chat() else { return nil }
        guard let run = chat.details[threadId]?.runs.last(where: { !ProcessLine.terminalRunStatuses.contains($0.status) }) else { return nil }
        return chat.processLine(for: run.runId, in: threadId)
    }

    public var queuedOffline: Bool {
        guard let threadId, let chat = chat() else { return false }
        return !chat.queuedMessages(in: threadId).isEmpty && chat.connection != .online
    }
}
#endif
