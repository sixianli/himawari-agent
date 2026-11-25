#if os(iOS)
import HimawariCore
import HimawariListen
import Observation
@preconcurrency import UserNotifications

@MainActor
@Observable
public final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = NotificationRouter()

    @ObservationIgnored var transport: (any ApprovalPushTransport)?
    @ObservationIgnored var mainChatOnScreen = false
    var approvalsRequested = false

    private static let approveAction = HimawariPush.ActionKind.approve.rawValue
    private static let denyAction = HimawariPush.ActionKind.deny.rawValue

    public func install() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(ListenNotificationRouting.categories.union(Self.himawariCategories))
    }

    private static var himawariCategories: Set<UNNotificationCategory> {
        [
            UNNotificationCategory(
                identifier: HimawariPush.actionsCategory,
                actions: [
                    UNNotificationAction(identifier: approveAction, title: L.text("push.approve"), options: [.authenticationRequired, .foreground]),
                    UNNotificationAction(identifier: denyAction, title: L.text("push.deny"), options: [.authenticationRequired, .destructive]),
                ],
                intentIdentifiers: []
            ),
            UNNotificationCategory(identifier: HimawariPush.plainCategory, actions: [], intentIdentifiers: []),
        ]
    }

    nonisolated static func presentation(category: String, push: HimawariPush?, mainChatOnScreen: Bool) -> UNNotificationPresentationOptions {
        if ListenNotificationRouting.handles(category: category) { return [.banner, .sound] }
        guard let push else { return [.banner, .list, .sound] }
        if push.kind == HimawariPush.approvalKind || !mainChatOnScreen { return [.banner, .list, .sound] }
        return []
    }

    public nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let content = notification.request.content
        let push = HimawariPush(userInfo: content.userInfo)
        let category = content.categoryIdentifier
        let onScreen = await MainActor.run { mainChatOnScreen }
        return Self.presentation(category: category, push: push, mainChatOnScreen: onScreen)
    }

    public nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let category = content.categoryIdentifier
        let actionIdentifier = response.actionIdentifier
        if ListenNotificationRouting.handles(category: category) {
            await ListenNotificationRouting.respond(category: category, actionIdentifier: actionIdentifier)
            return
        }
        guard let push = HimawariPush(userInfo: content.userInfo) else { return }
        await handle(push: push, actionIdentifier: actionIdentifier)
    }

    private func handle(push: HimawariPush, actionIdentifier: String) async {
        guard let kind = HimawariPush.ActionKind(rawValue: actionIdentifier) else {
            if push.kind == HimawariPush.approvalKind { approvalsRequested = true }
            return
        }
        guard let transport else {
            approvalsRequested = true
            return
        }
        let outcome = (try? await ApprovalPushReply(transport: transport).tap(kind, in: push)) ?? .openApp
        if outcome == .openApp { approvalsRequested = true }
    }
}
#endif
