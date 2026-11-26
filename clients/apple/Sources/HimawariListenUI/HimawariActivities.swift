import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import AppIntents
#endif

public enum TalkLivePhase: String, Codable, Hashable, Sendable {
    case listening
    case speaking
    case muted
}

public struct TalkLiveState: Codable, Hashable, Sendable {
    public var phase: TalkLivePhase
    public var startedAt: Date

    public init(phase: TalkLivePhase, startedAt: Date) {
        self.phase = phase
        self.startedAt = startedAt
    }

    public var title: String {
        switch phase {
        case .listening: L.text("live.talk.listening")
        case .speaking: L.text("live.talk.speaking")
        case .muted: L.text("live.talk.muted")
        }
    }
}

public struct BackgroundWorkLiveState: Codable, Hashable, Sendable {
    public var phase: String
    public var step: Int
    public var stepCount: Int
    public var completedCount: Int
    public var activity: String?
    public var updatedAt: String

    public init(phase: String, step: Int, stepCount: Int, completedCount: Int, activity: String?, updatedAt: String) {
        self.phase = phase
        self.step = step
        self.stepCount = stepCount
        self.completedCount = completedCount
        self.activity = activity
        self.updatedAt = updatedAt
    }

    public var waitingForOwner: Bool { phase == "waiting_for_owner" }
    public var finished: Bool { phase == "finished" }

    public var progress: String? {
        guard stepCount > 0, !finished else { return nil }
        return L.format("live.work.step", min(max(step, 1), stepCount), stepCount)
    }

    public var detail: String {
        if finished { return L.text("live.work.finished") }
        if waitingForOwner { return L.text("live.work.waiting") }
        return activity ?? L.text("live.work.working")
    }
}

public enum TalkCommand: Sendable {
    case toggleMute
    case end
}

@MainActor
public final class TalkCommandCenter {
    public static let shared = TalkCommandCenter()

    public var handler: (@MainActor (TalkCommand) async -> Void)?

    private init() {}

    public func perform(_ command: TalkCommand) async {
        await handler?(command)
    }
}

public struct HimawariActivityCard<Trailing: View>: View {
    private let title: String
    private let subtitle: String
    private let trailing: Trailing

    public init(title: String, subtitle: String, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 12) {
            SunflowerMark()
                .frame(width: DesignTokens.Chat.liveActivityMark, height: DesignTokens.Chat.liveActivityMark)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Color.hmText)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(Color.hmMuted)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(EdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 14))
    }

    public static func capsule(_ title: String, primary: Bool) -> some View {
        Text(title)
            .font(.subheadline.weight(primary ? .semibold : .regular))
            .foregroundStyle(primary ? Color.hmOnText : Color.hmText)
            .padding(.horizontal, primary ? 18 : 16)
            .frame(minHeight: DesignTokens.Chat.liveActivityButton)
            .background(primary ? Color.hmText : Color.hmFill, in: Capsule())
            .contentShape(Capsule())
    }
}

public struct HimawariIslandLabel: View {
    private let title: String

    public init(_ title: String) {
        self.title = title
    }

    public var body: some View {
        HStack(spacing: 6) {
            SunflowerMark()
                .frame(width: DesignTokens.Chat.liveActivityIslandMark, height: DesignTokens.Chat.liveActivityIslandMark)
            Text(title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
    }
}

#if canImport(ActivityKit) && os(iOS)
public struct TalkActivityAttributes: ActivityAttributes {
    public typealias ContentState = TalkLiveState

    public init() {}
}

public struct BackgroundWorkAttributes: ActivityAttributes {
    public typealias ContentState = BackgroundWorkLiveState

    public var subthreadId: String
    public var matter: String
    public var title: String?

    public init(subthreadId: String, matter: String, title: String?) {
        self.subthreadId = subthreadId
        self.matter = matter
        self.title = title
    }

    public var shownTitle: String {
        guard let title, !title.isEmpty else { return matter }
        return title
    }
}

public struct ToggleTalkMuteIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "Mute or unmute the conversation"
    public static let isDiscoverable = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        await TalkCommandCenter.shared.perform(.toggleMute)
        return .result()
    }
}

public struct EndTalkIntent: LiveActivityIntent {
    public static let title: LocalizedStringResource = "End the conversation"
    public static let isDiscoverable = false

    public init() {}

    public func perform() async throws -> some IntentResult {
        await TalkCommandCenter.shared.perform(.end)
        return .result()
    }
}
#endif
