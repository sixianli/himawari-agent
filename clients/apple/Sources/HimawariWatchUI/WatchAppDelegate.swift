#if os(watchOS)
import Foundation
import HimawariCore
import WatchConnectivity
import WatchKit

@MainActor
public final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    private var model: WatchModel?
    private let relay = PairingRelayReceiver()

    public func attach(_ model: WatchModel) {
        guard self.model == nil else { return }
        self.model = model
        relay.onLink = { [weak model] link in
            Task { @MainActor in model?.receivePairingLink(link) }
        }
        relay.activate()
        scheduleNextRefresh()
    }

    public func applicationDidBecomeActive() {
        scheduleNextRefresh()
    }

    public func refreshInBackground() async {
        await model?.refresh()
        scheduleNextRefresh()
    }

    private func scheduleNextRefresh() {
        guard let model else { return }
        WKApplication.shared().scheduleBackgroundRefresh(
            withPreferredDate: Date().addingTimeInterval(model.refreshInterval),
            userInfo: nil
        ) { _ in }
    }
}

final class PairingRelayReceiver: NSObject, WCSessionDelegate, @unchecked Sendable {
    var onLink: (@Sendable (String) -> Void)?

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        deliver(session.receivedApplicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        deliver(message)
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        deliver(userInfo)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        deliver(applicationContext)
    }

    private func deliver(_ message: [String: Any]) {
        if let link = WatchPairingRelay.link(in: message) { onLink?(link) }
    }
}
#endif
