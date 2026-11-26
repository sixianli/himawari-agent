#if os(iOS)
import ActivityKit
import Foundation
import HimawariCore
import HimawariListenUI

@MainActor
enum BackgroundWorkActivityTokens {
    private static var watching: Task<Void, Never>?

    static func watch(_ sync: PushTokenSync) {
        guard watching == nil else { return }
        watching = Task {
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    for await token in Activity<BackgroundWorkAttributes>.pushToStartTokenUpdates {
                        await sync.tokenArrived(token, for: .backgroundWorkStart)
                    }
                }
                group.addTask {
                    for await activity in Activity<BackgroundWorkAttributes>.activityUpdates {
                        follow(id: activity.id, subthreadId: activity.attributes.subthreadId, sync: sync)
                    }
                }
                for activity in Activity<BackgroundWorkAttributes>.activities {
                    follow(id: activity.id, subthreadId: activity.attributes.subthreadId, sync: sync)
                }
            }
        }
    }

    private nonisolated static func follow(id: String, subthreadId: String, sync: PushTokenSync) {
        let slot = PushSlot.backgroundWork(subthreadId)
        Task {
            guard let activity = activity(id: id) else { return }
            for await token in activity.pushTokenUpdates {
                await sync.tokenArrived(token, for: slot)
            }
        }
        Task {
            guard let activity = activity(id: id) else { return }
            for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
                await sync.activityEnded(slot)
                return
            }
        }
    }

    private nonisolated static func activity(id: String) -> Activity<BackgroundWorkAttributes>? {
        Activity<BackgroundWorkAttributes>.activities.first { $0.id == id }
    }
}
#endif
