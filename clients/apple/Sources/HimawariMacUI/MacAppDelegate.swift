#if os(macOS)
import AppKit
import HimawariCore
import HimawariDesign
import HimawariShell

@MainActor
public final class MacAppDelegate: NSObject, NSApplicationDelegate {
    private var controller: MenuBarController?

    public override init() {
        super.init()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if let folder = MacDemoScene.requestedOutput {
            MacDemo.record(into: folder)
            NSApp.terminate(nil)
            return
        }
        #endif
        NSApp.setActivationPolicy(.accessory)
        let model = MenuBarModel(app: AppModel(kind: .mac), settings: MacSettingsStore())
        controller = MenuBarController(model: model)
    }

    public func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == PairingInvitation.scheme {
            controller?.receivePairingLink(url)
        }
    }

    public func applicationDidBecomeActive(_ notification: Notification) {
        controller?.model.app.becameActive()
        controller?.model.settings.refreshPermissions()
    }
}
#endif
