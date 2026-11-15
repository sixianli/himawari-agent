#if DEBUG
import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

public enum ChatListManageDemo {
    private static func archivedThreads() -> [ThreadSummary] {
        let rows: [(String, Int)] = [("去年的旅行计划", 20), ("装修预算", 34)]
        return rows.map { row in
            let updated = DemoChatFixtures.now.addingTimeInterval(-Double(row.1) * 86_400).formatted(Date.ISO8601FormatStyle())
            let object: [String: Any] = [
                "threadId": "thread-archived-\(row.1)", "revision": 5, "status": "archived", "titleRef": "title:\(row.0)",
                "answerLocale": "zh-CN", "messageWatermark": 5, "createdAt": updated, "updatedAt": updated,
            ]
            return try! JSONDecoder().decode(ThreadSummary.self, from: JSONSerialization.data(withJSONObject: object))
        }
    }

    private static func actions(_ state: DemoChatState) -> ThreadListActions {
        var state = state
        for thread in archivedThreads() { state.texts[thread.titleRef ?? ""] = String((thread.titleRef ?? "").dropFirst("title:".count)) }
        return ThreadListActions(store: .demo(state), open: { _ in })
    }

    public static func search(_ state: DemoChatState, query: String) -> some View {
        ChatListView(store: .demo(state), open: { _ in }, searchText: query)
            .environment(\.listClock, DemoChatFixtures.now)
    }

    public static func deleteSheet(_ state: DemoChatState, activeTasks: Int) -> some View {
        let store = ChatStore.demo(state)
        let thread = store.threads[0]
        let tasks = (0..<activeTasks).map { ThreadTaskBinding(taskId: "task-\($0)", revision: 1, status: "active") }
        let impact = ThreadDeletionImpact(threadId: thread.threadId, threadRevision: thread.revision, tasks: tasks, deletionAllowed: activeTasks == 0)
        return DeleteThreadSheet(actions: ThreadListActions(store: store, open: { _ in }), thread: thread, impact: impact, loaded: true)
    }

    public static func archived(_ state: DemoChatState) -> some View {
        let archived = archivedThreads()
        let manage = actions(state)
        return ArchivedThreadsView(actions: manage, items: archived)
            .environment(\.listClock, DemoChatFixtures.now)
    }
}
#endif
