#if DEBUG
import Foundation
import HimawariCore

public struct DemoChatState {
    public var threads: [ThreadSummary] = []
    public var texts: [String: String] = [:]
    public var details: [String: ThreadDetail] = [:]
    public var queued: [OutboxItem] = []
    public var streaming: [String: StreamingReply] = [:]
    public var connection: ChatConnection = .online
    public var executions: [String: [ExecutionRecord]] = [:]

    public init() {}
}

extension ChatStore {
    public static func demo(_ state: DemoChatState) -> ChatStore {
        let store = ChatStore(
            api: DeviceAPI(http: DeviceHTTPClient()),
            store: MemoryLocalStore(),
            heartbeatSeconds: { .infinity },
            onSessionInvalid: {}
        )
        store.frozen = true
        store.threads = state.threads
        store.texts = state.texts
        store.details = state.details
        store.queued = state.queued
        store.streaming = state.streaming
        store.connection = state.connection
        store.executions = state.executions
        return store
    }
}

public enum DemoChatFixtures {
    public static let osakaThreadId = "thread-device-0000000000000000000000000000000a"

    public static let now: Date = {
        var components = DateComponents()
        components.year = 2026
        components.month = 11
        components.day = 12
        components.hour = 15
        return Calendar.current.date(from: components) ?? Date()
    }()

    private static func decode<T: Decodable>(_ object: Any) -> T {
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(T.self, from: data)
    }

    private static func iso(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle())
    }

    private static func thread(_ id: String, title: String, updated: Date, revision: Int = 3) -> [String: Any] {
        [
            "threadId": id, "revision": revision, "status": "active", "titleRef": "title:\(id)",
            "answerLocale": "zh-CN", "messageWatermark": revision, "createdAt": iso(updated), "updatedAt": iso(updated),
        ]
    }

    private static func message(_ id: String, _ sequence: Int, role: String, runId: String? = nil, at date: Date) -> [String: Any] {
        var object: [String: Any] = [
            "messageId": id, "sequence": sequence, "role": role, "contentRef": "text:\(id)",
            "status": "committed", "committedAt": iso(date),
        ]
        if let runId { object["runId"] = runId }
        return object
    }

    private static func detail(_ thread: [String: Any], messages: [[String: Any]], runs: [(String, String)]) -> ThreadDetail {
        decode([
            "thread": thread,
            "messages": messages,
            "runs": runs.map { ["runId": $0.0, "revision": 1, "status": $0.1] },
            "nextSequence": NSNull(),
        ] as [String: Any])
    }

    static let question = "周五去大阪见田中，帮我看下几点出门合适"
    static let answer = "会面定在 14:00，新大阪站附近。坐 9:30 的新干线，12:03 到，留出吃午饭的时间。你平时从家走到车站约 18 分钟，建议 8:50 出门。"
    static let answerOffline = "会面定在 14:00，新大阪站附近。坐 9:30 的新干线，12:03 到，留出吃午饭的时间。"
    static let answerStreaming = "会面定在 14:00，新大阪站附近。坐 9:30 的新干线"

    private static func todayAt(_ hour: Int, _ minute: Int, daysAgo: Int = 0) -> Date {
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: -daysAgo, to: now) ?? now
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    private static func steps(runId: String, start: Date) -> [ExecutionRecord] {
        let items: [(String, String, String)] = [
            ("calendar", "看了日历", "calendar"),
            ("route", "查了路线", "train"),
            ("weather", "看了天气", "cloud"),
            ("memory", "用了 1 条记忆", "affiliate"),
        ]
        var records: [ExecutionRecord] = []
        for (index, item) in items.enumerated() {
            records.append(ExecutionRecord(id: "\(runId)-\(index)-a", sequence: index * 2 + 1, itemId: item.0, kind: .tool, phase: .started, name: item.0, occurredAt: start.addingTimeInterval(Double(index * 3)), activity: item.1, activityIcon: item.2))
            records.append(ExecutionRecord(id: "\(runId)-\(index)-b", sequence: index * 2 + 2, itemId: item.0, kind: .tool, phase: .completed, name: item.0, occurredAt: start.addingTimeInterval(Double(index * 3 + 3)), activity: "", activityIcon: ""))
        }
        return records
    }

    private static func listThreads() -> (threads: [ThreadSummary], texts: [String: String], details: [String: ThreadDetail]) {
        let rows: [(String, String, Date, String)] = [
            (osakaThreadId, "周五去大阪", todayAt(14, 50), answer),
            ("thread-device-0000000000000000000000000000000b", "报价单 11 月", todayAt(18, 20, daysAgo: 1), "整理好了，放在文件里"),
            ("thread-device-0000000000000000000000000000000c", "妈妈的生日礼物", todayAt(20, 5, daysAgo: 2), "挑了三样，你看看"),
            ("thread-device-0000000000000000000000000000000d", "每周跑步计划", todayAt(7, 30, daysAgo: 3), "这周跑了 2 次，还差 1 次"),
        ]
        var threads: [ThreadSummary] = []
        var texts: [String: String] = [:]
        var details: [String: ThreadDetail] = [:]
        for row in rows {
            let thread = thread(row.0, title: row.1, updated: row.2)
            threads.append(decode(thread))
            texts["title:\(row.0)"] = row.1
            let reply = message("\(row.0)-2", 2, role: "agent", at: row.2)
            details[row.0] = detail(thread, messages: [reply], runs: [])
            texts["text:\(row.0)-2"] = row.3
        }
        return (threads, texts, details)
    }

    public static func chatList() -> DemoChatState {
        var state = DemoChatState()
        let list = listThreads()
        state.threads = list.threads
        state.texts = list.texts
        state.details = list.details
        return state
    }

    private static func osaka(messages: [[String: Any]], runs: [(String, String)], texts: [String: String]) -> DemoChatState {
        var state = DemoChatState()
        let base = thread(osakaThreadId, title: "周五去大阪", updated: todayAt(14, 50))
        state.threads = [decode(base)]
        state.details[osakaThreadId] = detail(base, messages: messages, runs: runs)
        state.texts = texts.merging(["title:\(osakaThreadId)": "周五去大阪"]) { $1 }
        return state
    }

    public static func answered() -> DemoChatState {
        let start = todayAt(14, 48)
        var state = osaka(
            messages: [
                message("m1", 1, role: "owner", at: start),
                message("m2", 2, role: "agent", runId: "run:0a", at: start.addingTimeInterval(13)),
            ],
            runs: [("run:0a", "completed")],
            texts: ["text:m1": question, "text:m2": answer]
        )
        state.executions["run:0a"] = steps(runId: "run:0a", start: start)
        return state
    }

    public static func sending() -> DemoChatState {
        var state = osaka(messages: [], runs: [], texts: [:])
        let created = todayAt(14, 48)
        let first = OutgoingMessage(messageId: "queued-0000000000000001", threadId: osakaThreadId, expectedRevision: 3, text: question, createdAt: created)
        let second = OutgoingMessage(messageId: "queued-0000000000000002", threadId: osakaThreadId, expectedRevision: 3, text: "顺便看下那天的天气", createdAt: created)
        state.queued = [
            decode(["message": jsonObject(first), "state": "sending", "attempts": 1]),
            decode(["message": jsonObject(second), "state": "waiting", "attempts": 1]),
        ]
        return state
    }

    private static func jsonObject(_ message: OutgoingMessage) -> Any {
        let data = try! JSONEncoder().encode(message)
        return try! JSONSerialization.jsonObject(with: data)
    }

    public static func offline() -> DemoChatState {
        let start = todayAt(14, 48)
        var state = osaka(
            messages: [
                message("m1", 1, role: "owner", at: start),
                message("m2", 2, role: "agent", at: start.addingTimeInterval(13)),
            ],
            runs: [],
            texts: ["text:m1": question, "text:m2": answerOffline]
        )
        state.connection = .offline
        return state
    }

    public static func answering() -> DemoChatState {
        let start = now.addingTimeInterval(-6)
        var state = osaka(
            messages: [message("m1", 1, role: "owner", at: start)],
            runs: [("run:0b", "running")],
            texts: ["text:m1": question]
        )
        state.executions["run:0b"] = [
            ExecutionRecord(id: "run:0b-0", sequence: 1, itemId: "route", kind: .tool, phase: .started, name: "route", occurredAt: start, activity: "正在查路线", activityIcon: "train"),
        ]
        let chunk: ExecutionText = decode(["threadId": osakaThreadId, "runId": "run:0b", "itemId": "answer", "offset": 0, "text": answerStreaming] as [String: Any])
        var reply = StreamingReply(runId: "run:0b")
        reply.apply(chunk)
        state.streaming[osakaThreadId] = reply
        return state
    }

    public static func longConversation() -> DemoChatState {
        let start = todayAt(9, 0)
        var messages: [[String: Any]] = []
        var texts: [String: String] = [:]
        var runs: [(String, String)] = []
        var state = DemoChatState()
        for index in 0..<8 {
            let runId = "run:\(String(format: "%02x", index + 16))"
            let at = start.addingTimeInterval(Double(index * 600))
            messages.append(message("q\(index)", index * 2 + 1, role: "owner", at: at))
            messages.append(message("a\(index)", index * 2 + 2, role: "agent", runId: runId, at: at.addingTimeInterval(13)))
            texts["text:q\(index)"] = index == 0 ? question : "再帮我确认一下第 \(index) 件事"
            texts["text:a\(index)"] = answer
            runs.append((runId, "completed"))
            state.executions[runId] = steps(runId: runId, start: at)
        }
        let base = osaka(messages: messages, runs: runs, texts: texts)
        state.threads = base.threads
        state.details = base.details
        state.texts = base.texts
        return state
    }
}
#endif
