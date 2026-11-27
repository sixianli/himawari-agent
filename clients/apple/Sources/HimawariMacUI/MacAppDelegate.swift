#if os(macOS)
import AppKit
import HimawariCore
import HimawariDesign
import HimawariShell
import SwiftUI

@MainActor
public final class MacAppDelegate: NSObject, NSApplicationDelegate {
    let menu: MenuBarModel
    let main: MacMainModel
    let updater: MacUpdater?
    private var controller: MenuBarController?
    private var openWindow: OpenWindowAction?
    private var openSettingsAction: OpenSettingsAction?

    public override init() {
        let app = AppModel(kind: .mac)
        menu = MenuBarModel(app: app, settings: MacSettingsStore())
        main = MacMainModel(app: app)
        updater = MacUpdater.forMainBundle()
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
        let controller = MenuBarController(model: menu)
        controller.openMain = { [weak self] in self?.showMainWindow() }
        controller.openSettingsWindow = { [weak self] in self?.showSettings() }
        controller.openAwaiting = { [weak self] in
            guard let self else { return }
            main.go(to: .her(.approvals))
            showMainWindow()
        }
        self.controller = controller
    }

    func register(_ openWindow: OpenWindowAction, _ openSettings: OpenSettingsAction) {
        self.openWindow = openWindow
        openSettingsAction = openSettings
    }

    func showMainWindow() {
        guard main.isSignedIn else { return }
        NSApp.activate()
        openWindow?(id: MacScenes.mainWindow)
    }

    func showSettings() {
        NSApp.activate()
        openSettingsAction?()
    }

    public func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == PairingInvitation.scheme {
            controller?.receivePairingLink(url)
        }
    }

    public func applicationDidBecomeActive(_ notification: Notification) {
        menu.app.becameActive()
        menu.settings.refreshPermissions()
    }

    public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    public func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            if main.isSignedIn { showMainWindow() } else { controller?.showPairing() }
        }
        return true
    }
}
#endif
