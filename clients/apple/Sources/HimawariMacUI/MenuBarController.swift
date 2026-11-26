#if os(macOS)
import AppKit
import HimawariCore
import HimawariDesign
import HimawariShell
import SwiftUI
import UserNotifications

@MainActor
final class MenuBarController: NSObject, NSWindowDelegate, NSDraggingDestination {
    let model: MenuBarModel
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let popover = NSPopover()
    private let inputBar: InputBarWindow
    private let notices = ResultNotices()
    private var shortcut: GlobalShortcut?
    private var settingsWindow: NSWindow?
    private var signInWindow: NSWindow?
    private var observation: Task<Void, Never>?
    private let messages: MessagesSensor
    private let presence: PresenceSensor

    init(model: MenuBarModel) {
        self.model = model
        inputBar = InputBarWindow(model: InputBarModel(api: model.app.api, chat: { [weak app = model.app] in app?.chat }, limits: { [weak app = model.app] in app?.configuration?.attachments }), menu: model)
        messages = MessagesSensor(settings: model.settings, app: model.app)
        presence = PresenceSensor(app: model.app)
        super.init()
        configureStatusItem()
        configurePopover()
        shortcut = GlobalShortcut { [weak self] in self?.summonInputBar() }
        applyShortcut(model.settings.settings.shortcut)
        model.settings.onShortcutChange = { [weak self] in self?.applyShortcut($0) }
        notices.prepare()
        notices.openPanel = { [weak self] id in
            self?.model.reveal(id)
            self?.showPanel()
        }
        model.showNotice = { [weak self] in self?.notices.show($0) }
        model.removeNotice = { [weak self] in self?.notices.withdraw($0) }
        model.app.onDeviceNotification = { [weak model] in model?.receive($0) }
        model.startRefreshing()
        messages.start()
        presence.start()
        observeBadge()
        if model.app.phase != .active { showSignIn() }
    }

    private func applyShortcut(_ value: KeyShortcut) {
        model.shortcutChanged(shortcut?.register(value))
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        button.image = Self.sunflowerImage()
        button.imagePosition = .imageLeading
        button.target = self
        button.action = #selector(statusItemClicked(_:))
        _ = button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.setAccessibilityLabel(L.text("app.name"))
        button.window?.registerForDraggedTypes([.fileURL])
        button.window?.delegate = self
    }

    private func configurePopover() {
        popover.behavior = .transient
        popover.animates = true
        let host = NSHostingController(rootView: PanelView(
            model: model,
            talk: { [weak self] in
                self?.popover.performClose(nil)
                self?.summonInputBar()
            },
            pair: { [weak self] in
                self?.popover.performClose(nil)
                self?.showSignIn()
            }
        ))
        host.sizingOptions = .preferredContentSize
        popover.contentViewController = host
    }

    private func observeBadge() {
        observation = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                updateBadge(model.awaitingCount)
                if model.app.phase == .active { signInWindow?.close() }
                await withCheckedContinuation { continuation in
                    withObservationTracking {
                        _ = self.model.awaitingCount
                        _ = self.model.app.phase
                    } onChange: {
                        continuation.resume()
                    }
                }
            }
        }
    }

    private func updateBadge(_ count: Int) {
        guard let button = statusItem.button else { return }
        if count > 0 {
            button.attributedTitle = NSAttributedString(string: String(count), attributes: [
                .font: NSFont.systemFont(ofSize: DesignTokens.TypeScale.badge.size, weight: .bold),
                .foregroundColor: NSColor(DesignTokens.Colors.badge.color),
            ])
        } else {
            button.title = ""
        }
    }

    static func sunflowerImage() -> NSImage {
        let renderer = ImageRenderer(content: SunflowerBadge(size: DesignTokens.Mac.statusIcon))
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        let image = renderer.nsImage ?? NSImage()
        image.isTemplate = false
        return image
    }

    @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(withTitle: L.text("menu.settings"), action: #selector(openSettings), keyEquivalent: ",").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: L.text("menu.quit"), action: #selector(quit), keyEquivalent: "q").target = self
            statusItem.menu = menu
            sender.performClick(nil)
            statusItem.menu = nil
            return
        }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            showPanel()
        }
    }

    func showPanel() {
        guard let button = statusItem.button, !popover.isShown else { return }
        Task { await model.refresh() }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func summonInputBar(files: [URL] = []) {
        guard model.app.phase == .active else {
            showSignIn()
            return
        }
        let snapshot = files.isEmpty
            ? ContextReader.snapshot(seesFrontmost: model.settings.settings.seesFrontmost, excluding: Bundle.main.bundleIdentifier)
            : ContextSnapshot()
        inputBar.show(snapshot: snapshot, seesFrontmost: model.settings.settings.seesFrontmost, files: files)
    }

    @objc func openSettings() {
        if settingsWindow == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: SettingsHost(model: model)))
            window.title = L.text("settings.title")
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            settingsWindow = window
        }
        NSApp.activate()
        settingsWindow?.center()
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    func showSignIn() {
        if signInWindow == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: MacSignInWindow(model: model.app)))
            window.title = L.text("app.name")
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            signInWindow = window
        }
        NSApp.activate()
        signInWindow?.center()
        signInWindow?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === signInWindow { signInWindow = nil }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        Self.fileURLs(sender).isEmpty ? [] : .link
    }

    func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = Self.fileURLs(sender)
        guard !urls.isEmpty else { return false }
        summonInputBar(files: urls)
        return true
    }

    static func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        return (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL]) ?? []
    }
}

struct SettingsHost: View {
    let model: MenuBarModel

    var body: some View {
        MacSettingsView(store: model.settings, shortcutState: model.shortcutState)
    }
}

@MainActor
final class InputBarWindow {
    private let model: InputBarModel
    private weak var menu: MenuBarModel?
    private var panel: InputPanel?

    init(model: InputBarModel, menu: MenuBarModel) {
        self.model = model
        self.menu = menu
    }

    func show(snapshot: ContextSnapshot, seesFrontmost: Bool, files: [URL]) {
        model.begin(with: snapshot, seesFrontmost: seesFrontmost)
        if !files.isEmpty { model.add(files: files) }
        let panel = panel ?? makePanel()
        self.panel = panel
        if let screen = NSScreen.main {
            let frame = screen.visibleFrame
            panel.setFrameTopLeftPoint(NSPoint(x: frame.midX - DesignTokens.Mac.inputBarWidth / 2, y: frame.minY + frame.height * 0.62))
        }
        NSApp.activate()
        panel.makeKeyAndOrderFront(nil)
    }

    private func makePanel() -> InputPanel {
        let panel = InputPanel()
        let host = NSHostingView(rootView: InputBarHost(model: model, menu: menu))
        host.sizingOptions = [.preferredContentSize]
        panel.contentView = host
        panel.onClose = { [weak self] in
            self?.model.close()
            self?.panel?.orderOut(nil)
        }
        return panel
    }
}

struct InputBarHost: View {
    let model: InputBarModel
    let menu: MenuBarModel?

    var body: some View {
        InputBarView(model: model, shortcutLabel: menu?.activeShortcutLabel, submit: model.send)
    }
}

final class InputPanel: NSPanel {
    var onClose: () -> Void = {}

    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView], backing: .buffered, defer: true)
        isFloatingPanel = true
        level = .floating
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        hidesOnDeactivate = false
        isMovableByWindowBackground = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    }

    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onClose()
    }

    override func resignKey() {
        super.resignKey()
        onClose()
    }
}

@MainActor
final class ResultNotices: NSObject, UNUserNotificationCenterDelegate {
    static let category = "himawari.mac.result"
    static let undo = "undo"
    static let reveal = "reveal"
    var undoHandler: ((String) -> Void)?

    func prepare() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([UNNotificationCategory(
            identifier: Self.category,
            actions: [
                UNNotificationAction(identifier: Self.undo, title: L.text("notice.undo")),
                UNNotificationAction(identifier: Self.reveal, title: L.text("notice.reveal"), options: [.foreground]),
            ],
            intentIdentifiers: []
        )])
        center.requestAuthorization(options: [.alert]) { _, _ in }
    }

    var openPanel: ((String) -> Void)?

    static func noticeIdentifier(_ id: String) -> String { "himawari.notice." + id }

    func show(_ notice: DeviceNotification) {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.userInfo = ["noticeId": notice.id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: Self.noticeIdentifier(notice.id), content: content, trigger: nil))
    }

    func withdraw(_ id: String) {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [Self.noticeIdentifier(id)])
        center.removePendingNotificationRequests(withIdentifiers: [Self.noticeIdentifier(id)])
    }

    func announce(id: String, sentence: String, detail: String?, files: [URL], undoable: Bool) {
        let content = UNMutableNotificationContent()
        content.title = sentence
        if let detail { content.body = detail }
        content.userInfo = ["actionId": id, "files": files.map(\.path), "undoable": undoable]
        if !files.isEmpty || undoable { content.categoryIdentifier = Self.category }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let id = info["actionId"] as? String ?? ""
        let noticeId = info["noticeId"] as? String
        let files = (info["files"] as? [String] ?? []).map { URL(fileURLWithPath: $0) }
        let action = response.actionIdentifier
        await MainActor.run {
            if let noticeId {
                if action == UNNotificationDefaultActionIdentifier { openPanel?(noticeId) }
                return
            }
            switch action {
            case Self.reveal, UNNotificationDefaultActionIdentifier:
                if !files.isEmpty { NSWorkspace.shared.activateFileViewerSelecting(files) }
            case Self.undo:
                undoHandler?(id)
            default:
                break
            }
        }
    }
}
#endif
