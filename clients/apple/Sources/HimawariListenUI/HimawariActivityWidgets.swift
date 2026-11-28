#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import AppIntents
import HimawariCore
import HimawariDesign
import SwiftUI
import WidgetKit

public struct TalkActivityWidget: Widget {
    public init() {}

    public var body: some WidgetConfiguration {
        ActivityConfiguration(for: TalkActivityAttributes.self) { context in
            TalkActivityCard(state: context.state)
                .activityBackgroundTint(Color.hmGlass)
                .activitySystemActionForegroundColor(Color.hmText)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    TalkActivityCard(state: context.state)
                        .environment(\.colorScheme, .dark)
                }
            } compactLeading: {
                HimawariIslandLabel(context.state.title)
            } compactTrailing: {
                ListenElapsedText(startedAt: context.state.startedAt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .frame(maxWidth: DesignTokens.Chat.liveActivityIslandTrailing)
            } minimal: {
                SunflowerMark()
                    .frame(width: DesignTokens.Chat.liveActivityIslandMark, height: DesignTokens.Chat.liveActivityIslandMark)
            }
        }
    }
}

struct TalkActivityCard: View {
    let state: TalkLiveState

    var body: some View {
        HimawariActivityCard(title: state.title, subtitle: L.text("live.talk.title")) {
            Button(intent: ToggleTalkMuteIntent()) {
                HimawariActivityCard<EmptyView>.capsule(L.text(state.phase == .muted ? "live.talk.unmute" : "live.talk.mute"), primary: false)
            }
            .buttonStyle(.pressable)
            Button(intent: EndTalkIntent()) {
                HimawariActivityCard<EmptyView>.capsule(L.text("live.talk.end"), primary: true)
            }
            .buttonStyle(.pressable)
        }
    }
}

public struct BackgroundWorkActivityWidget: Widget {
    public init() {}

    public var body: some WidgetConfiguration {
        ActivityConfiguration(for: BackgroundWorkAttributes.self) { context in
            BackgroundWorkActivityCard(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Color.hmGlass)
                .activitySystemActionForegroundColor(Color.hmText)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    BackgroundWorkActivityCard(attributes: context.attributes, state: context.state)
                        .environment(\.colorScheme, .dark)
                }
            } compactLeading: {
                HimawariIslandLabel(context.attributes.shownTitle)
            } compactTrailing: {
                if let progress = context.state.progress {
                    Text(progress)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                }
            } minimal: {
                SunflowerMark()
                    .frame(width: DesignTokens.Chat.liveActivityIslandMark, height: DesignTokens.Chat.liveActivityIslandMark)
            }
        }
    }
}

struct BackgroundWorkActivityCard: View {
    let attributes: BackgroundWorkAttributes
    let state: BackgroundWorkLiveState

    var body: some View {
        HimawariActivityCard(title: attributes.shownTitle, subtitle: state.detail) {
            if let progress = state.progress {
                Text(progress)
                    .font(.footnote)
                    .foregroundStyle(Color.hmMuted)
                    .monospacedDigit()
            }
        }
    }
}
#endif
