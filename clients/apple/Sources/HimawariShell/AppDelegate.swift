#if canImport(UIKit)
import HimawariCore
import UIKit

public final class HimawariAppDelegate: NSObject, UIApplicationDelegate {
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
