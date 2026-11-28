#if canImport(UIKit)
import HimawariCore
import HimawariListenUI
import HimawariSenses
import UIKit

@MainActor
public enum PushBridge {
    public static var sync: PushTokenSync?
}

public final class HimawariAppDelegate: NSObject, UIApplicationDelegate {
    public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        NotificationRouter.shared.install()
        #if os(iOS)
        HealthWake.install()
        #endif
        _ = AppModel.launched
        return true
    }

    public func applicationWillTerminate(_ application: UIApplication) {
        #if canImport(ActivityKit) && os(iOS)
        ListenActivities.endAllBeforeExit()
        #endif
    }

    public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let sync = PushBridge.sync else { return }
        Task { await sync.tokenArrived(deviceToken) }
    }

    public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    public func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let id = SilentWithdrawPush.notificationId(in: userInfo) else {
            completionHandler(.noData)
            return
        }
        nonisolated(unsafe) let finish = completionHandler
        Task {
            await NotificationSettler(center: SystemDeliveredNotifications()).withdraw(notificationId: id)
            finish(.newData)
        }
    }
}
#endif
