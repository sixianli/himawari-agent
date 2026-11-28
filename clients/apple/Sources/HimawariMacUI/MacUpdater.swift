#if os(macOS)
import Foundation
import Observation
import Sparkle

@MainActor
@Observable
final class MacUpdater {
    private(set) var canCheck = false
    private(set) var checksAutomatically = false
    @ObservationIgnored private let controller: SPUStandardUpdaterController
    @ObservationIgnored private var observation: NSKeyValueObservation?

    static func isConfigured(feed: Any?, publicKey: Any?) -> Bool {
        guard let feed = feed as? String, let url = URL(string: feed), url.scheme == "https", url.host() != nil else { return false }
        guard let publicKey = publicKey as? String, let data = Data(base64Encoded: publicKey) else { return false }
        return data.count == 32
    }

    static func forMainBundle() -> MacUpdater? {
        let bundle = Bundle.main
        guard isConfigured(
            feed: bundle.object(forInfoDictionaryKey: "SUFeedURL"),
            publicKey: bundle.object(forInfoDictionaryKey: "SUPublicEDKey")
        ) else { return nil }
        return MacUpdater()
    }

    private init() {
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        canCheck = controller.updater.canCheckForUpdates
        checksAutomatically = controller.updater.automaticallyChecksForUpdates
        observation = controller.updater.observe(\.canCheckForUpdates, options: [.new]) { @Sendable [weak self] updater, _ in
            let value = updater.canCheckForUpdates
            Task { @MainActor in self?.canCheck = value }
        }
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    func setChecksAutomatically(_ on: Bool) {
        controller.updater.automaticallyChecksForUpdates = on
        checksAutomatically = controller.updater.automaticallyChecksForUpdates
    }
}
#endif
