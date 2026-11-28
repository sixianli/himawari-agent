import HimawariChat
import HimawariCore
import HimawariDesign
import HimawariManage
import HimawariSenses
import SwiftUI

public struct MainChatPane: View {
    private let model: AppModel
    private let chat: ChatStore
    private let draft: String
    @State private var mainThreadId: String?
    @State private var lookupFailed = false

    public init(model: AppModel, chat: ChatStore, draft: String = "") {
        self.model = model
        self.chat = chat
        self.draft = draft
    }

    public var body: some View {
        Group {
            if let mainThreadId {
                ChatView(store: chat, threadId: mainThreadId, draft: draft)
                    .environment(\.chatStopRun, stopRun)
                    .environment(\.chatChooseOption, chooseOption)
                    .environment(\.chatOwnerAwaited, (model.actions?.waitingCount ?? 0) > 0)
                    .environment(\.chatAttachLimits, model.configuration?.attachments)
            } else {
                MainThreadWaiting(failed: lookupFailed) { Task { await findMainThread() } }
            }
        }
        .task {
            guard mainThreadId == nil else { return }
            await findMainThread()
        }
    }

    private func findMainThread() async {
        lookupFailed = false
        do {
            mainThreadId = try await MainThreadLocator(api: model.api, confirmKey: model.confirmKey).mainThreadId()
        } catch {
            lookupFailed = true
        }
    }

    private var stopRun: @MainActor @Sendable (String, ThreadRunSummary) async throws -> Void {
        let stopper = ThreadRunStopper(api: model.api, confirmKey: model.confirmKey)
        return { threadId, run in try await stopper.stop(threadId: threadId, run: run) }
    }

    private var chooseOption: @MainActor @Sendable (String, ThreadMessage, MessageOptions.Item) async throws -> Void {
        let chooser = ThreadOptionChooser(api: model.api, confirmKey: model.confirmKey)
        return { threadId, message, item in
            guard let options = message.options else { return }
            try await chooser.choose(threadId: threadId, messageId: message.messageId, options: options, item: item)
        }
    }
}

public struct HerSectionPane: View {
    private let model: AppModel
    private let section: HerSection
    private let workspace: HerWorkspace
    private let talk: (String) -> Void
    private let openChat: () -> Void

    public init(model: AppModel, section: HerSection, workspace: HerWorkspace, talk: @escaping (String) -> Void, openChat: @escaping () -> Void) {
        self.model = model
        self.section = section
        self.workspace = workspace
        self.talk = talk
        self.openChat = openChat
    }

    public var body: some View {
        HerSectionView(
            section: section,
            workspace: workspace,
            actions: model.actions,
            senses: model.senses.map { senses in
                AnyView(SensesView(model: senses) { HandoverEntryRows() })
            },
            perceptionDeletion: model.senses.map { senses in
                { (close: @escaping () -> Void) -> AnyView in AnyView(PerceptionDeletionView(model: PerceptionDeletionModel(senses: senses), close: close)) }
            },
            sensesOn: { model.senses?.status?.senses.count },
            talk: talk,
            openChat: openChat,
            removedThisDevice: { model.removedThisDevice() },
            unsentMessages: { model.unsentMessages }
        )
        .id(section)
    }
}
