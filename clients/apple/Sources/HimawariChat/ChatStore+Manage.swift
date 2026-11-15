import Foundation
import HimawariCore

public enum ThreadManageResult: Sendable, Equatable {
    case done
    case conflict
    case blocked
    case failed
}

extension ChatStore {
    public func visibleThreads(matching query: String) -> [ThreadSummary] {
        threads.filter { thread in
            ThreadSearch.matches(query, in: [title(for: thread), lastMessageText(in: thread.threadId)])
        }
    }

    public func isPinned(_ thread: ThreadSummary) -> Bool {
        thread.pinOrder != nil
    }

    public func rename(_ thread: ThreadSummary, to title: String) async -> ThreadManageResult {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failed }
        let revision = currentRevision(of: thread)
        return await manage { try await $0.renameThread(thread.threadId, expectedRevision: revision, title: trimmed) }
    }

    public func setPinned(_ thread: ThreadSummary, _ pinned: Bool) async -> ThreadManageResult {
        let revision = currentRevision(of: thread)
        return await manage { try await $0.pinThread(thread.threadId, expectedRevision: revision, pinOrder: pinned ? 0 : nil) }
    }

    public func archive(_ thread: ThreadSummary) async -> ThreadManageResult {
        await lifecycle(ThreadGatewayCommand.archive, thread)
    }

    public func restore(_ thread: ThreadSummary) async -> ThreadManageResult {
        await lifecycle(ThreadGatewayCommand.restore, thread)
    }

    public func setAnswerLocale(_ thread: ThreadSummary, _ locale: AnswerLocale) async -> ThreadManageResult {
        let revision = currentRevision(of: thread)
        return await manage { try await $0.setThreadAnswerLocale(thread.threadId, expectedRevision: revision, locale: locale) }
    }

    public func fork(_ thread: ThreadSummary) async -> String? {
        guard !frozen else { return nil }
        if details[thread.threadId] == nil { await load(thread.threadId) }
        guard let source = ThreadForkSource.latest(in: messages(in: thread.threadId)) else { return nil }
        do {
            let created = try await api.forkThread(from: thread.threadId, turnId: source.turnId, watermark: source.watermark)
            await refreshThreads()
            return created.threadId
        } catch {
            await handle(error)
            return nil
        }
    }

    public func deletionImpact(of thread: ThreadSummary) async -> ThreadDeletionImpact? {
        guard !frozen else { return nil }
        do {
            return try await api.deletionImpact(threadId: thread.threadId)
        } catch {
            await handle(error)
            return nil
        }
    }

    public func delete(_ thread: ThreadSummary, pausingActiveTasks: Bool) async -> ThreadManageResult {
        guard !frozen else { return .failed }
        do {
            var impact = try await api.deletionImpact(threadId: thread.threadId)
            if pausingActiveTasks, !impact.activeTasks.isEmpty {
                for task in impact.activeTasks { _ = try await api.pauseTask(task, in: thread.threadId) }
                impact = try await api.deletionImpact(threadId: thread.threadId)
            }
            guard impact.deletionAllowed else { return .blocked }
            let outcome = try await api.lifecycleThread(ThreadGatewayCommand.trash, threadId: thread.threadId, expectedRevision: impact.threadRevision)
            await refreshThreads()
            if case .conflict = outcome { return .conflict }
            details[thread.threadId] = nil
            return .done
        } catch {
            await handle(error)
            return .failed
        }
    }

    public func archivedThreads() async -> [ThreadSummary]? {
        guard !frozen else { return nil }
        do {
            let archived = try await api.allThreads(statuses: [.archived]).sorted(by: Self.listOrder)
            await loadTexts(archived.compactMap(\.titleRef))
            return archived
        } catch {
            await handle(error)
            return nil
        }
    }

    private func currentRevision(of thread: ThreadSummary) -> Int {
        max(thread.revision, details[thread.threadId]?.thread.revision ?? 0)
    }

    private func lifecycle(_ type: String, _ thread: ThreadSummary) async -> ThreadManageResult {
        let revision = currentRevision(of: thread)
        return await manage { try await $0.lifecycleThread(type, threadId: thread.threadId, expectedRevision: revision) }
    }

    private func manage(_ call: (DeviceAPI) async throws -> CommandOutcome) async -> ThreadManageResult {
        guard !frozen else { return .failed }
        do {
            let outcome = try await call(api)
            await refreshThreads()
            if case .conflict = outcome { return .conflict }
            return .done
        } catch {
            await handle(error)
            return .failed
        }
    }
}
