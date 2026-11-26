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
    public var backgroundWork: BackgroundWork?

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
        store.offlineShown = state.connection != .online
        store.executions = state.executions
        store.backgroundWork = state.backgroundWork
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

    private static func message(_ id: String, _ sequence: Int, role: String, runId: String? = nil, at date: Date, options: [String: Any]? = nil, chosenFrom: [String: String]? = nil) -> [String: Any] {
        var object: [String: Any] = [
            "messageId": id, "sequence": sequence, "role": role, "contentRef": "text:\(id)",
            "status": "committed", "committedAt": iso(date),
        ]
        if let runId { object["runId"] = runId }
        if let options { object["options"] = options }
        if let chosenFrom { object["chosenFrom"] = chosenFrom }
        return object
    }

    private static func options(_ setId: String, state: String, _ items: [(id: String, label: String, action: String?)]) -> [String: Any] {
        [
            "setId": setId,
            "items": items.map { item -> [String: Any] in
                [
                    "optionId": item.id, "label": item.label, "reason": NSNull(), "state": state,
                    "action": item.action.map { ["tool": "mail.reply", "summary": $0] as [String: Any] } ?? NSNull(),
                ]
            },
        ]
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
    static let answerFormatted = """
    三班里 **9:30 那班最合适**：

    - 7:00：太早，到了要等 4 个小时
    - **9:30**：12:03 到，能吃午饭
    - 11:00：13:33 到，太赶

    | 出发 | 到达 | 指定席 |
    | --- | --- | --- |
    | 9:30 | 12:03 | 还有 |
    | 11:00 | 13:33 | 只剩靠过道 |
    """
    static let richQuestion = "写个 Swift 函数算两站之间的车程，顺便给我官网链接"
    static let richAnswer = """
    可以用 `TimeInterval` 算差值，[JR 东海官网](https://jr-central.co.jp) 有时刻表，也可以直接看 https://www.jr-central.co.jp/timetable 。

    ```swift
    func ride(from start: Date, to end: Date) -> Int {
        let minutes = end.timeIntervalSince(start) / 60
        return Int(minutes.rounded())
    }
    ```

    没写语言的代码块不上色：

    ```
    9:30 -> 12:03
    ```

    | 出发 | 到达 | 车程 |
    | --- | --- | --- |
    | 9:30 | 12:03 | 153 分钟 |

    另外 5*3 是 15，a.b 只是字段名。
    """
    static let answerFormattedStreaming = "三班里 **9:30 那班最合适**：\n\n- 7:00：太早，到了要等 4 个小时\n- **9:30**：12:0"

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

    public static func formatted() -> DemoChatState {
        let start = todayAt(14, 48)
        return osaka(
            messages: [
                message("m1", 1, role: "owner", at: start),
                message("m2", 2, role: "agent", at: start.addingTimeInterval(13)),
            ],
            runs: [],
            texts: ["text:m1": question, "text:m2": answerFormatted]
        )
    }

    public static func rich() -> DemoChatState {
        let start = todayAt(14, 48)
        return osaka(
            messages: [
                message("m1", 1, role: "owner", at: start),
                message("m2", 2, role: "agent", at: start.addingTimeInterval(13)),
            ],
            runs: [],
            texts: ["text:m1": richQuestion, "text:m2": richAnswer]
        )
    }

    static let replyAnswer = "周五大阪晴转多云，最高 18 度，傍晚降温明显。"
    static let replyQuestion = "那要带外套吗？"
    static let replyAnswerTwo = "要带。傍晚会降到 9 度左右，一件薄外套就够。"
    static let replyToGone = "这条也帮我记一下"

    public static func empty() -> DemoChatState {
        osaka(messages: [], runs: [], texts: [:])
    }

    public static func replied() -> DemoChatState {
        let start = todayAt(14, 48)
        return osaka(
            messages: [
                message("m1", 1, role: "owner", at: start),
                message("m2", 2, role: "agent", at: start.addingTimeInterval(13)),
                message("m3", 3, role: "owner", at: start.addingTimeInterval(60)),
                message("m4", 4, role: "agent", at: start.addingTimeInterval(70)),
                message("m5", 5, role: "owner", at: start.addingTimeInterval(120)),
            ],
            runs: [],
            texts: [
                "text:m1": question,
                "text:m2": replyAnswer,
                "text:m3": MessageReply.compose(replyingTo: "m2", text: replyQuestion),
                "text:m4": replyAnswerTwo,
                "text:m5": MessageReply.compose(replyingTo: "m0", text: replyToGone),
            ]
        )
    }

    public static let talkHeard = "那天大阪会下雨吗"

    static let releaseQuestion = "新 iPhone 什么时候发售？"
    static let releaseAnswer = "苹果还没公布日期。往年都在 9 月第二周发布、隔一周的周五开卖，照这个算大概是 9 月 18 日。"
    static let tanakaNote = "田中来信问周四下午能不能见面。你周四 15:00 以后空着。"
    static let tanakaReply = "回复 田中：周四 15:00 可以"
    static let tanakaDone = "发出去了。周四 15:00 也记进了日历。"

    public static func withOptions() -> DemoChatState {
        let start = todayAt(14, 48)
        return osaka(
            messages: [
                message("m1", 1, role: "owner", at: start),
                message("m2", 2, role: "agent", at: start.addingTimeInterval(9), options: options("set-1", state: "open", [
                    ("o1", "查哪家最便宜", nil),
                    ("o2", "发售前一天提醒我", nil),
                    (MessageOptions.dismissId, "不用了", nil),
                ])),
            ],
            runs: [],
            texts: ["text:m1": releaseQuestion, "text:m2": releaseAnswer]
        )
    }

    public static func optionChosen() -> DemoChatState {
        let start = todayAt(14, 30)
        return osaka(
            messages: [
                message("m1", 1, role: "agent", at: start, options: options("set-2", state: "stale", [
                    ("o1", tanakaReply, "给田中回邮件：周四 15:00 可以"),
                    ("o2", "回复 田中：改到周五", "给田中回邮件：改到周五"),
                    ("o3", "先记进日历", nil),
                ])),
                message("m2", 2, role: "owner", at: start.addingTimeInterval(40), chosenFrom: ["setId": "set-2", "optionId": "o1"]),
                message("m3", 3, role: "agent", at: start.addingTimeInterval(52)),
            ],
            runs: [],
            texts: ["text:m1": tanakaNote, "text:m2": tanakaReply, "text:m3": tanakaDone]
        )
    }

    public static func formattedStreaming() -> DemoChatState {
        var state = answering()
        let chunk: ExecutionText = decode(["threadId": osakaThreadId, "runId": "run:0b", "itemId": "answer", "offset": 0, "text": answerFormattedStreaming] as [String: Any])
        var reply = StreamingReply(runId: "run:0b")
        reply.apply(chunk)
        state.streaming[osakaThreadId] = reply
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

public extension DemoChatFixtures {
    static let backgroundFlightsId = "thread-sub-0000000000000000000000000000000b"

    static func backgroundWork(empty: Bool = false) -> DemoChatState {
        var state = answered()
        guard !empty else {
            state.backgroundWork = BackgroundWork(matters: [])
            return state
        }
        let morning = todayAt(10, 0)
        typealias Sub = BackgroundWork.Subthread
        let flights = Sub(
            subthreadId: backgroundFlightsId,
            status: .open,
            activity: .running,
            openedAt: morning,
            updatedAt: todayAt(14, 40),
            progress: "三班都查到了，正在比价格和到达时间，下午给你结果。",
            progressAt: todayAt(14, 35),
            runCount: 2,
            spentMicros: 70_000,
            budgetMicros: 300_000,
            title: "订去大阪的机票",
            runs: [
                .init(runId: "run:sub-1", status: "completed", startedAt: todayAt(10, 5), updatedAt: todayAt(10, 9)),
                .init(runId: "run:sub-2", status: "running", startedAt: todayAt(14, 30), updatedAt: todayAt(14, 40)),
            ],
            exchanges: [
                .init(direction: .toSubthread, kind: .brief, text: "订 12 月 3 日早上去大阪的机票，经济舱，靠窗，预算 300 美元以内。", at: todayAt(10, 0)),
                .init(direction: .toMain, kind: .question, text: "关西机场和伊丹机场都可以吗？伊丹离酒店更近，但便宜的班次少。", at: todayAt(10, 8)),
                .init(direction: .toSubthread, kind: .message, text: "都可以，优先伊丹。", at: todayAt(10, 20)),
                .init(direction: .toMain, kind: .progress, text: "三班都查到了，正在比价格和到达时间。", at: todayAt(14, 35)),
            ],
            tasks: [
                .init(number: 1, status: .completed, subject: "查 12 月 3 日早上的航班"),
                .init(number: 2, status: .inProgress, subject: "比价格和到达时间", activeForm: "正在比三班的价格"),
                .init(number: 3, status: .pending, subject: "订票并发确认"),
            ]
        )
        let hotel = Sub(
            subthreadId: "thread-sub-0000000000000000000000000000000c",
            status: .open,
            activity: .overBudget,
            openedAt: morning,
            updatedAt: todayAt(14, 20),
            spentMicros: 310_000,
            budgetMicros: 300_000,
            title: "订梅田附近的酒店"
        )
        let invoices = Sub(
            subthreadId: "thread-sub-0000000000000000000000000000000d",
            status: .open,
            activity: .waitingResult,
            openedAt: todayAt(9, 0),
            updatedAt: todayAt(13, 10),
            spentMicros: 4_000,
            budgetMicros: 200_000,
            title: "整理 11 月发票",
            tasks: [
                .init(number: 1, status: .completed, subject: "找出邮件里的发票"),
                .init(number: 2, status: .inProgress, subject: "等会计系统导出", activeForm: "在等会计系统导出"),
            ]
        )
        state.backgroundWork = BackgroundWork(matters: [
            .init(matter: "12 月 3 日大阪出差", subthreads: [flights, hotel]),
            .init(matter: "报销", subthreads: [invoices]),
        ])
        let early = todayAt(10, 5)
        state.executions["run:sub-1"] = [
            ExecutionRecord(id: "s1a", sequence: 1, itemId: "search", kind: .tool, phase: .completed, name: "search", occurredAt: early, activity: "查了航班", activityIcon: "plane"),
        ]
        let late = todayAt(14, 30)
        state.executions["run:sub-2"] = [
            ExecutionRecord(id: "s2a", sequence: 1, itemId: "web", kind: .tool, phase: .completed, name: "web", occurredAt: late, activity: "看了三家航空公司的网页", activityIcon: "world-search"),
            ExecutionRecord(id: "s2b", sequence: 2, itemId: "table", kind: .tool, phase: .completed, name: "table", occurredAt: late.addingTimeInterval(240), activity: "列了价格对比表", activityIcon: "table"),
            ExecutionRecord(id: "s2c", sequence: 3, itemId: "calc", kind: .tool, phase: .started, name: "calc", occurredAt: late.addingTimeInterval(540), activity: "在算到酒店的时间", activityIcon: "calculator"),
        ]
        return state
    }
}
#endif
