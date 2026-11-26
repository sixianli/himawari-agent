import HimawariCore
import SwiftUI

@MainActor
public protocol ChatVoiceInput: AnyObject, Sendable {
    func start(onText: @escaping @MainActor (String) -> Void) async throws
    func finish() async -> String
    func cancel() async
}

public enum TalkPhase: Equatable, Sendable {
    case starting
    case listening
    case herTurn
    case muted
}

@MainActor
public protocol ChatTalk: AnyObject, Sendable {
    var phase: TalkPhase { get }
    var muted: Bool { get }
    var heard: String { get }
    var levels: [Double] { get }
    var suggestsVoiceDownload: Bool { get }
    var running: Bool { get }
    func begin(onSaid: @escaping @MainActor (_ said: String, _ messageId: String) -> Void) async throws
    func herReply(_ markdown: String, finished: Bool)
    func setMuted(_ muted: Bool)
    func end() async
}

extension EnvironmentValues {
    @Entry public var chatVoice: (any ChatVoiceInput)? = nil
    @Entry public var chatOpensAttachSheet = false
    @Entry public var chatReadsPhotoLibrary = true
    @Entry public var chatOpensSelectText: String? = nil
    @Entry public var chatShowsCopied = false
    @Entry public var chatStartsReplyTo: String? = nil
    @Entry public var chatAttachLimits: AttachmentLimits? = nil
    @Entry public var chatTalk: (any ChatTalk)? = nil
    @Entry public var chatOpensTalk = false
    @Entry public var chatOwnerAwaited = false
    @Entry public var chatStopRun: (@MainActor @Sendable (_ threadId: String, _ run: ThreadRunSummary) async throws -> Void)? = nil
    @Entry public var chatChooseOption: (@MainActor @Sendable (_ threadId: String, _ message: ThreadMessage, _ item: MessageOptions.Item) async throws -> Void)? = nil
}

enum HoldPhase: Equatable {
    case listening(String)
    case cancelling
}

enum HoldEvent {
    case began
    case moved(outside: Bool)
    case ended
}
