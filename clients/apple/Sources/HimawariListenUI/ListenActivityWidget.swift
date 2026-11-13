#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import AppIntents
import HimawariCore
import HimawariDesign
import SwiftUI
import WidgetKit

public struct ListenActivityWidget: Widget {
    public init() {}

    public var body: some WidgetConfiguration {
        ActivityConfiguration(for: ListenActivityAttributes.self) { context in
            ListenActivityLockView(state: context.state)
                .activityBackgroundTint(Color.hmGlass)
                .activitySystemActionForegroundColor(Color.hmText)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    ListenActivityLockView(state: context.state)
                        .environment(\.colorScheme, .dark)
                }
            } compactLeading: {
                HStack(spacing: 6) {
                    SunflowerMark(detail: .compact)
                        .frame(width: 18, height: 18)
                    Text(ListenActivityLockView.title(context.state))
                        .font(.system(size: 13, weight: .semibold))
                }
            } compactTrailing: {
                ListenElapsedText(startedAt: context.state.startedAt)
                    .font(.rounded(13, weight: .regular))
                    .foregroundStyle(.white.opacity(0.8))
                    .monospacedDigit()
                    .frame(maxWidth: 52)
            } minimal: {
                SunflowerMark(detail: .compact)
                    .frame(width: 18, height: 18)
            }
        }
    }
}

struct ListenActivityLockView: View {
    let state: ListenLiveState

    static func title(_ state: ListenLiveState) -> String {
        switch state.phase {
        case .listening: L.text("live.listening")
        case .paused: L.text("live.paused")
        case .calling: L.text("live.calling")
        case .asking: L.text("live.ask")
        }
    }

    var body: some View {
        switch state.phase {
        case .listening:
            ListenLockBanner(state: state) { label in
                Button(intent: PauseListeningIntent()) { label }.buttonStyle(.plain)
            } stop: { label in
                Button(intent: StopListeningIntent()) { label }.buttonStyle(.plain)
            }
        case .paused:
            ListenLockBanner(state: state) { _ in
                Button(intent: ResumeListeningIntent()) {
                    Text(L.text("notice.continue"))
                        .font(.system(size: 15))
                        .foregroundStyle(Color.hmText)
                        .padding(.horizontal, 16)
                        .frame(height: 44)
                        .background(Color.hmFill, in: Capsule())
                }
                .buttonStyle(.plain)
            } stop: { label in
                Button(intent: StopListeningIntent()) { label }.buttonStyle(.plain)
            }
        case .calling:
            ListenCallPanel(state: state, levels: VoiceLevels.resting)
                .environment(\.colorScheme, .dark)
        case .asking:
            ListenAskPanel(state: state) { label in
                Button(intent: NotMeIntent()) { label }.buttonStyle(.plain)
            } itsMe: { label in
                Button(intent: ItsMeIntent()) { label }.buttonStyle(.plain)
            }
            .environment(\.colorScheme, .dark)
        }
    }
}
#endif
