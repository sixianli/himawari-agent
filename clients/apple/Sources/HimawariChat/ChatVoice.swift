import HimawariCore
import SwiftUI

@MainActor
public protocol ChatVoiceInput: AnyObject, Sendable {
    func start(onText: @escaping @MainActor (String) -> Void) async throws
    func finish() async -> String
    func cancel() async
}

extension EnvironmentValues {
    @Entry public var chatVoice: (any ChatVoiceInput)? = nil
    @Entry public var chatOpensAttachSheet = false
    @Entry public var chatStopRun: (@MainActor (_ threadId: String, _ run: ThreadRunSummary) async throws -> Void)? = nil
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
