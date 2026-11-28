#if os(iOS)
import HimawariCore
import HimawariListen
import Observation
@preconcurrency import UserNotifications

@MainActor
@Observable
public final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = NotificationRouter()

    @ObservationIgnored var transport: DeviceAPI?
    @ObservationIgnored var mainChatOnScreen = false
    var approvalsRequested = false
    var agentGrantRequested = false
    var vaultRequested = false

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
            UNNotificationCategory(
                identifier: HimawariPush.vaultCodeCategory,
                actions: [
                    UNTextInputNotificationAction(
                        identifier: HimawariPush.vaultCodeAction,
                        title: L.text("push.vaultCode.enter"),
                        options: [.authenticationRequired],
                        textInputButtonTitle: L.text("push.vaultCode.fill"),
                        textInputPlaceholder: L.text("push.vaultCode.placeholder")
                    ),
                ],
                intentIdentifiers: []
            ),
        ]
    }

    nonisolated static func presentation(category: String, push: HimawariPush?, mainChatOnScreen: Bool) -> UNNotificationPresentationOptions {
        if ListenNotificationRouting.handles(category: category) { return [.banner, .sound] }
        guard let push else { return [.banner, .list, .sound] }
        if [HimawariPush.approvalKind, HimawariPush.agentGrantKind, HimawariPush.vaultApprovalKind, HimawariPush.vaultCodeKind].contains(push.kind) || !mainChatOnScreen { return [.banner, .list, .sound] }
        return []
    }

    public nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let content = notification.request.content
        let push = HimawariPush(userInfo: content.userInfo)
        let category = content.categoryIdentifier
        let onScreen = await MainActor.run {
            if push?.kind == HimawariPush.agentGrantKind { agentGrantRequested = true }
            return mainChatOnScreen
        }
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
        if let typed = (response as? UNTextInputNotificationResponse)?.userText {
            await handleCode(typed, in: push)
            return
        }
        await handle(push: push, actionIdentifier: actionIdentifier)
    }

    private func handleCode(_ typed: String, in push: HimawariPush) async {
        guard let api = transport else {
            vaultRequested = true
            return
        }
        if await VaultCodePushReply(transport: api).typed(typed, in: push) == .openApp { vaultRequested = true }
    }

    private func handle(push: HimawariPush, actionIdentifier: String) async {
        guard let kind = HimawariPush.ActionKind(rawValue: actionIdentifier) else {
            if push.kind == HimawariPush.vaultApprovalKind || push.kind == HimawariPush.vaultCodeKind { vaultRequested = true }
            if push.kind == HimawariPush.approvalKind { approvalsRequested = true }
            if push.kind == HimawariPush.agentGrantKind { agentGrantRequested = true }
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
