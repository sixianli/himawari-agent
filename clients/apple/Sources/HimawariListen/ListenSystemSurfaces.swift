#if os(iOS)
import ActivityKit
import Foundation
import HimawariCore
import HimawariListenUI
@preconcurrency import UserNotifications

@MainActor
final class ListenActivityController {
    private var current: Activity<ListenActivityAttributes>?

    func start(state: ListenLiveState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        end()
        current = try? Activity.request(attributes: ListenActivityAttributes(), content: ActivityContent(state: state, staleDate: nil))
    }

    func update(_ state: ListenLiveState) {
        guard let id = current?.id else { return }
        Task { await Self.update(id: id, state: state) }
    }

    func end() {
        guard let id = current?.id else { return }
        current = nil
        Task { await Self.end(id: id) }
    }

    private nonisolated static func activity(id: String) -> Activity<ListenActivityAttributes>? {
        Activity<ListenActivityAttributes>.activities.first { $0.id == id }
    }

    private nonisolated static func update(id: String, state: ListenLiveState) async {
        guard let activity = activity(id: id) else { return }
        await activity.update(ActivityContent(state: state, staleDate: nil))
    }

    private nonisolated static func end(id: String) async {
        guard let activity = activity(id: id) else { return }
        await activity.end(nil, dismissalPolicy: .immediate)
    }
}

@MainActor
final class ListenNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let pausedCategory = "listen.paused"
    static let askCategory = "listen.ask"
    static let noticeCategory = "listen.notice"
    static let continueAction = "listen.continue"
    static let notMeAction = "listen.notMe"
    static let itsMeAction = "listen.itsMe"
    static let pauseEndedId = "listen.pauseEnded"

    private let center = UNUserNotificationCenter.current()

    func install() {
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.pausedCategory,
                actions: [UNNotificationAction(identifier: Self.continueAction, title: ListenNoticeText.continueAction, options: [.foreground])],
                intentIdentifiers: []
            ),
            UNNotificationCategory(
                identifier: Self.askCategory,
                actions: [
                    UNNotificationAction(identifier: Self.notMeAction, title: ListenNoticeText.notMeAction, options: []),
                    UNNotificationAction(identifier: Self.itsMeAction, title: ListenNoticeText.itsMeAction, options: [.authenticationRequired]),
                ],
                intentIdentifiers: []
            ),
            UNNotificationCategory(identifier: Self.noticeCategory, actions: [], intentIdentifiers: []),
        ])
    }

    func prepare() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
        center.removePendingNotificationRequests(withIdentifiers: [Self.pauseEndedId])
    }

    func post(_ notice: ListeningNotice, policy: ListeningPolicy, now: Date) {
        let text = ListenNoticeText.of(notice, policy: policy, now: now)
        let category = notice == .pausedTapToContinue ? Self.pausedCategory : Self.noticeCategory
        deliver(id: "listen.\(UUID().uuidString)", title: text.title, body: text.body, category: category, at: nil)
    }

    func schedulePauseEnded(at date: Date) {
        let text = ListenNoticeText.pauseHourEnded
        deliver(id: Self.pauseEndedId, title: text.title, body: text.body, category: Self.pausedCategory, at: date)
    }

    func ask(heard: String, reason: SpokenCommandRefusal, onAirPods: Bool) {
        let body = ListenText.askExplanation(heard: heard, reason: reason) + (onAirPods ? "\n" + ListenNoticeText.askOnAirPods : "")
        deliver(id: "listen.ask", title: ListenNoticeText.askTitle, body: body, category: Self.askCategory, at: nil)
    }

    private func deliver(id: String, title: String, body: String, category: String, at date: Date?) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.categoryIdentifier = category
        content.interruptionLevel = .active
        let trigger = date.map { UNTimeIntervalNotificationTrigger(timeInterval: max(1, $0.timeIntervalSinceNow), repeats: false) }
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let category = response.notification.request.content.categoryIdentifier
        let command: ListenCommand? = switch (category, response.actionIdentifier) {
        case (Self.askCategory, Self.notMeAction): .notMe
        case (Self.askCategory, Self.itsMeAction): .itsMe
        case (Self.pausedCategory, _): .resume
        default: nil
        }
        guard let command else { return }
        await ListenCommandCenter.shared.perform(command)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
#endif
