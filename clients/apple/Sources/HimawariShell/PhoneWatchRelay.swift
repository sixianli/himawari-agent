#if os(iOS)
import Foundation
import HimawariCore
import WatchConnectivity

final class PhoneWatchRelay: NSObject, WCSessionDelegate, @unchecked Sendable {
    override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    var canOffer: Bool {
        guard WCSession.isSupported() else { return false }
        let session = WCSession.default
        return session.activationState == .activated && session.isPaired && session.isWatchAppInstalled
    }

    func send(_ link: String) {
        guard canOffer else { return }
        WCSession.default.transferUserInfo(WatchPairingRelay.message(link))
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}
#endif
