#if os(iOS)
import ActivityKit
import Foundation
import HimawariListenUI

@MainActor
final class TalkActivityController {
    private var current: Activity<TalkActivityAttributes>?
    private var shown: TalkLiveState?

    func show(_ state: TalkLiveState) {
        guard state != shown else { return }
        shown = state
        if let id = current?.id {
            Task { await Self.update(id: id, state: state) }
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        current = try? Activity.request(attributes: TalkActivityAttributes(), content: ActivityContent(state: state, staleDate: nil))
    }

    func end() {
        shown = nil
        guard let id = current?.id else { return }
        current = nil
        Task { await Self.end(id: id) }
    }

    private nonisolated static func activity(id: String) -> Activity<TalkActivityAttributes>? {
        Activity<TalkActivityAttributes>.activities.first { $0.id == id }
    }

    private nonisolated static func update(id: String, state: TalkLiveState) async {
        guard let activity = activity(id: id) else { return }
        await activity.update(ActivityContent(state: state, staleDate: nil))
    }

    private nonisolated static func end(id: String) async {
        guard let activity = activity(id: id) else { return }
        await activity.end(nil, dismissalPolicy: .immediate)
    }
}
#endif
