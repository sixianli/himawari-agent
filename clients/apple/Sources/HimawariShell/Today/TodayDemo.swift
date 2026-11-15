#if DEBUG
import Foundation
import HimawariChat
import HimawariCore

struct DemoHomeSource: HomeFeedSource {
    let snapshot: HomeFeedSnapshot

    func read(locale: HomeLocale) async throws -> HomeFeedSnapshot {
        snapshot
    }

    func act(_ item: HomeFeedItem, action: HomeFeedAction, revision: String) async throws -> HomeActOutcome {
        HomeActOutcome(message: action.label, undo: nil)
    }
}

@MainActor
enum TodayDemo {
    static let deviceApprovalId = "apr_demo_alarm"

    static func feed(_ snapshot: HomeFeedSnapshot, toast: (key: String, message: String, undo: Bool)? = nil) -> HomeFeedModel {
        HomeFeedModel(snapshot: snapshot, source: DemoHomeSource(snapshot: snapshot), toast: toast)
    }

    static func at(_ offset: TimeInterval) -> String {
        DemoChatFixtures.now.addingTimeInterval(offset).formatted(.iso8601)
    }

    static let mailAsk = HomeFeedItem(
        key: "insight:mail-tanaka",
        kind: "heads_up",
        awaitsOwner: true,
        sentence: "田中把周五的会改到 15:00，出门提醒要跟着改吗",
        target: .init(type: "mail", id: "mail-tanaka", threadId: nil),
        source: .init(type: "mail", from: "田中", label: "从他今天 15:42 的邮件看到的", threadId: nil, at: at(-18 * 60)),
        createdAt: at(-18 * 60),
        actions: [
            HomeFeedAction(action: "dismiss", label: "不用", polarity: .negative, binding: "demo-dismiss"),
            HomeFeedAction(action: "done", label: "改到 9:40", polarity: .positive, binding: "demo-done"),
        ],
        rank: "deadline"
    )

    static let mailApproval = HomeFeedItem(
        key: "approval:apr-mail-tanaka",
        kind: "approval",
        awaitsOwner: true,
        sentence: "回田中的邮件：周五 15:00 可以",
        target: .init(type: "approval", id: "apr-mail-tanaka", threadId: DemoChatFixtures.osakaThreadId),
        source: .init(type: "conversation", from: nil, label: nil, threadId: DemoChatFixtures.osakaThreadId, at: at(-10 * 60)),
        deadline: at(3600),
        createdAt: at(-10 * 60),
        actions: [
            HomeFeedAction(action: "approved", label: "发出去", polarity: .positive),
            HomeFeedAction(action: "denied", label: "不发", polarity: .negative),
        ]
    )

    static let deviceApproval = HomeFeedItem(
        key: "approval:\(deviceApprovalId)",
        kind: "approval",
        awaitsOwner: true,
        sentence: nil,
        sentenceBasis: "none",
        target: .init(type: "approval", id: deviceApprovalId, threadId: DemoChatFixtures.osakaThreadId),
        source: .init(type: "conversation", from: nil, label: nil, threadId: DemoChatFixtures.osakaThreadId, at: at(-20 * 60)),
        deadline: at(600),
        createdAt: at(-20 * 60),
        actions: [
            HomeFeedAction(action: "approved", label: "定好", polarity: .positive),
            HomeFeedAction(action: "denied", label: "不用", polarity: .negative),
        ]
    )

    static let heard = HomeFeedItem(
        key: "memory_request:tanaka-tokyo",
        kind: "memory_confirm",
        awaitsOwner: true,
        sentence: "田中下周三回东京",
        target: .init(type: "memory_request", id: "tanaka-tokyo", threadId: nil),
        source: .init(type: "conversation", from: nil, label: "开会时听到的，要记吗", threadId: nil, at: at(-40 * 60)),
        createdAt: at(-40 * 60),
        actions: [
            HomeFeedAction(action: "approved", label: "记下", polarity: .positive),
            HomeFeedAction(action: "rejected", label: "不记", polarity: .negative),
        ]
    )

    static let running = HomeFeedItem(
        key: "run:train",
        kind: "running",
        awaitsOwner: false,
        sentence: "正在看新干线要不要改签",
        target: .init(type: "thread", id: DemoChatFixtures.osakaThreadId, threadId: DemoChatFixtures.osakaThreadId),
        source: .init(type: "conversation", from: nil, label: "你改了出门时间，它接着做的", threadId: DemoChatFixtures.osakaThreadId, at: at(-2 * 60)),
        createdAt: at(-2 * 60),
        rank: "recency"
    )

    static let done = HomeFeedItem(
        key: "review:meeting",
        kind: "done",
        awaitsOwner: false,
        sentence: "会议要点整理好了",
        target: .init(type: "thread", id: DemoChatFixtures.osakaThreadId, threadId: DemoChatFixtures.osakaThreadId),
        source: .init(type: "memory", from: nil, label: "11:18 开完会替你做的", threadId: DemoChatFixtures.osakaThreadId, at: at(-4 * 3600)),
        createdAt: at(-4 * 3600),
        rank: "recency"
    )

    static let upcoming = [
        HomeUpcoming(reminderId: "rem-mom", memoryId: "mem-mom", text: "给妈妈打电话", dueAt: at(6 * 3600)),
        HomeUpcoming(reminderId: "rem-osaka", memoryId: "mem-osaka", text: "该出门了，去大阪", dueAt: at(17 * 3600 + 40 * 60)),
    ]

    static func snapshot(_ items: [HomeFeedItem], upcoming: [HomeUpcoming] = TodayDemo.upcoming) -> HomeFeedSnapshot {
        HomeFeedSnapshot(
            items: items,
            awaitingCount: items.filter(\.awaitsOwner).count,
            upcoming: upcoming,
            revision: "demo",
            generatedAt: at(0)
        )
    }

    static var first: HomeFeedModel {
        feed(snapshot([mailAsk, mailApproval, heard, done]))
    }

    static var withDeviceApproval: HomeFeedModel {
        feed(snapshot([deviceApproval, mailAsk, heard, done]))
    }

    static var settled: HomeFeedModel {
        feed(snapshot([mailAsk, mailApproval, heard, running, done]), toast: (mailAsk.key, "出门提醒改到 9:40 了", true))
    }

    static var quiet: HomeFeedModel {
        feed(snapshot([]))
    }
}
#endif
