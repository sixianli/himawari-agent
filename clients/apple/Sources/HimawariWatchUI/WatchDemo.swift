#if os(watchOS) && DEBUG
import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI
import WidgetKit

public enum WatchDemoScene: String, CaseIterable {
    case reminder = "11-watch-1-reminder"
    case decide = "11-watch-2-decide"
    case talkReady = "11-watch-3-talk"
    case talkThinking = "11-watch-3b-thinking"
    case talkShown = "11-watch-3c-short-answer"
    case talkReading = "11-watch-3d-long-answer"
    case talkFailed = "11-watch-3e-failed"
    case handOff = "11-watch-5-hand-off"
    case quiet = "11-watch-6-quiet"
    case offline = "11-watch-6b-offline"
    case unpaired = "11-watch-7-unpaired"
    case unpairedProblem = "11-watch-7b-code-expired"
    case connecting = "11-watch-7c-connecting"
    case waiting = "11-watch-7d-waiting"
    case glanceWaitingRectangular = "11-watch-8-glance-rectangular-waiting"
    case glanceQuietRectangular = "11-watch-8b-glance-rectangular-quiet"
    case glanceWaitingCircular = "11-watch-8c-glance-circular-waiting"
    case glanceQuietCircular = "11-watch-8d-glance-circular-quiet"

    public static var requested: WatchDemoScene? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-HimawariWatchDemoScene"), arguments.indices.contains(index + 1) else { return nil }
        return WatchDemoScene(rawValue: arguments[index + 1])
    }

    private static let at = Calendar.current.date(bySettingHour: 9, minute: 40, second: 0, of: Date(timeIntervalSince1970: 1_794_000_000)) ?? Date(timeIntervalSince1970: 1_794_000_000)

    private func action(_ name: String, _ label: String, _ polarity: String, owner: Bool = false) -> HomeAction {
        HomeAction(action: name, label: label, polarity: polarity, ownerPresence: owner, binding: "demo")
    }

    private func home(_ items: [WatchItem], awaiting: Int) -> WatchHome {
        WatchHome(items: items, awaitingCount: awaiting, revision: "demo")
    }

    @MainActor
    func model() -> WatchModel {
        switch self {
        case .reminder:
            WatchModel(demoPhase: .active, home: home([
                WatchItem(key: "reminder:1", awaitsOwner: true, sentence: "该出门了", detail: "10:30 的新干线，走到车站 18 分钟", deadline: Self.at, actions: [action("done", "知道了", "neutral")]),
            ], awaiting: 1))
        case .decide:
            WatchModel(demoPhase: .active, home: home([
                WatchItem(key: "insight:1", awaitsOwner: true, sentence: "周五的会改到 15:00", detail: "出门提醒要跟着改吗", deadline: nil, actions: [action("done", "改到 9:40", "positive"), action("dismiss", "不用", "negative")]),
            ], awaiting: 3))
        case .handOff:
            WatchModel(demoPhase: .active, home: home([
                WatchItem(key: "approval:1", awaitsOwner: true, sentence: "给田中的邮件", detail: "要先看内容，刷脸才发", deadline: nil, actions: [action("approved", "看内容再定", "positive", owner: true)]),
            ], awaiting: 1))
        case .quiet:
            WatchModel(demoPhase: .active, home: home([], awaiting: 0))
        case .offline:
            WatchModel(demoPhase: .active, home: nil, homeFailed: true)
        case .talkReady: WatchModel(demoPhase: .active, home: home([], awaiting: 0), talk: .idle)
        case .talkThinking: WatchModel(demoPhase: .active, home: home([], awaiting: 0), talk: .waiting, said: "明天早上八点叫我起床")
        case .talkShown: WatchModel(demoPhase: .active, home: home([], awaiting: 0), talk: .shown("记下了：今晚九点给妈妈打电话。"))
        case .talkReading: WatchModel(demoPhase: .active, home: home([], awaiting: 0), talk: .reading(first: "会面定在 14:00，新大阪站附近。"))
        case .talkFailed: WatchModel(demoPhase: .active, home: home([], awaiting: 0), talk: .failed, said: "今晚九点给妈妈打电话")
        case .unpaired: WatchModel(demoPhase: .unpaired(nil))
        case .unpairedProblem: WatchModel(demoPhase: .unpaired(.codeExpired(ttlSeconds: nil)))
        case .connecting: WatchModel(demoPhase: .submitting)
        case .waiting: WatchModel(demoPhase: .waitingForConfirmation(number: "482 913"))
        case .glanceWaitingRectangular, .glanceQuietRectangular, .glanceWaitingCircular, .glanceQuietCircular: WatchModel(demoPhase: .active)
        }
    }

    var glance: (state: WatchComplicationState, family: WidgetFamily)? {
        let busy = WatchComplicationState(awaiting: 3, latest: "周五的会改到 15:00", updatedAt: Self.at)
        let quiet = WatchComplicationState(awaiting: 0, latest: nil, updatedAt: Self.at)
        switch self {
        case .glanceWaitingRectangular: return (busy, .accessoryRectangular)
        case .glanceQuietRectangular: return (quiet, .accessoryRectangular)
        case .glanceWaitingCircular: return (busy, .accessoryCircular)
        case .glanceQuietCircular: return (quiet, .accessoryCircular)
        default: return nil
        }
    }

    var showsTalk: Bool {
        switch self {
        case .talkReady, .talkThinking, .talkShown, .talkReading, .talkFailed: true
        default: false
        }
    }
}

public struct WatchDemoView: View {
    private let scene: WatchDemoScene
    @State private var model: WatchModel

    public init(scene: WatchDemoScene) {
        self.scene = scene
        _model = State(initialValue: scene.model())
    }

    public var body: some View {
        if let glance = scene.glance {
            WatchGlanceView(state: glance.state, family: glance.family)
                .padding(DesignTokens.Watch.glancePadding)
                .frame(
                    width: glance.family == .accessoryCircular ? DesignTokens.Watch.glanceCircle : DesignTokens.Watch.glanceWidth,
                    height: glance.family == .accessoryCircular ? DesignTokens.Watch.glanceCircle : DesignTokens.Watch.glanceHeight
                )
                .background(Color.hmFillStrong, in: RoundedRectangle(cornerRadius: DesignTokens.Watch.glanceRadius))
                .containerBackground(.black, for: .navigation)
        } else if scene.showsTalk {
            TalkView(model: model).containerBackground(.black, for: .navigation)
        } else {
            DemoHomeContainer(model: model)
        }
    }
}

struct DemoHomeContainer: View {
    let model: WatchModel

    var body: some View {
        Group {
            switch model.phase {
            case let .unpaired(problem): UnpairedView(model: model, problem: problem)
            case .submitting: ConnectingView()
            case let .waitingForConfirmation(number): WaitingView(model: model, number: number)
            case .active: HomeStatic(model: model)
            }
        }
        .containerBackground(.black, for: .navigation)
    }
}

struct HomeStatic: View {
    let model: WatchModel

    var body: some View {
        NavigationStack {
            Group {
                if let card = model.card {
                    CardView(model: model, card: card)
                } else {
                    QuietView(failed: model.homeFailed, waiting: model.home?.awaitsOwnerWithoutCard == true)
                }
            }
        }
    }
}
#endif
