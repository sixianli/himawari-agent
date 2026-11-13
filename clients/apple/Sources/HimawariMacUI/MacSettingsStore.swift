#if os(macOS)
import AppKit
import ApplicationServices
import Foundation
import HimawariCore
import Observation

@MainActor
@Observable
final class MacSettingsStore {
    private(set) var settings: MacAccessSettings
    private(set) var accessibilityAllowed: Bool
    @ObservationIgnored private let file: URL?
    @ObservationIgnored var onShortcutChange: ((KeyShortcut) -> Void)?

    init(file: URL? = MacSettingsStore.defaultFile) {
        self.file = file
        let saved = file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(MacAccessSettings.self, from: $0) }
        settings = saved ?? MacAccessSettings()
        accessibilityAllowed = AXIsProcessTrusted()
        settings.folders = settings.folders.map(Self.refreshed)
    }

    init(demo: MacAccessSettings, messagesReadable: Bool = true) {
        file = nil
        settings = demo
        accessibilityAllowed = true
        self.messagesReadable = messagesReadable
    }

    static var defaultFile: URL? {
        try? FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("himawari-mac", isDirectory: true)
            .appendingPathComponent("settings.json")
    }

    private static func refreshed(_ grant: FolderGrant) -> FolderGrant {
        guard let bookmark = grant.bookmark else { return grant }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: bookmark, options: [.withoutUI], bookmarkDataIsStale: &stale) else { return grant }
        guard url.path != grant.path || stale else { return grant }
        return FolderGrant(id: grant.id, path: url.path, access: grant.access, bookmark: (try? url.bookmarkData()) ?? bookmark)
    }

    private func save() {
        guard let file else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(settings).write(to: file, options: .atomic)
    }

    func folderExists(_ grant: FolderGrant) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: grant.path, isDirectory: &directory) && directory.boolValue
    }

    func addFolders(_ urls: [URL]) {
        for url in urls {
            settings.add(FolderGrant(path: url.path, access: .read, bookmark: try? url.bookmarkData()))
        }
        save()
    }

    func setAccess(_ access: FolderAccess, for grantId: String) {
        guard let index = settings.folders.firstIndex(where: { $0.id == grantId }) else { return }
        settings.folders[index].access = access
        save()
    }

    func removeFolder(_ grantId: String) {
        settings.folders.removeAll { $0.id == grantId }
        save()
    }

    func addApps(_ urls: [URL]) {
        for url in urls {
            guard let bundle = Bundle(url: url), let bundleId = bundle.bundleIdentifier else { continue }
            let name = FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
            settings.add(AppGrant(bundleId: bundleId, name: name))
        }
        save()
    }

    func removeApp(_ bundleId: String) {
        settings.apps.removeAll { $0.bundleId == bundleId }
        save()
    }

    func setSeesFrontmost(_ on: Bool) {
        settings.seesFrontmost = on
        if on { askForAccessibility() }
        save()
    }

    func setSeesMessages(_ on: Bool) {
        settings.seesMessages = on
        if !on { settings.messagesAfterRow = nil }
        save()
    }

    func setMessagesAfterRow(_ row: Int64?) {
        guard settings.seesMessages else { return }
        settings.messagesAfterRow = row
        save()
    }

    func setShortcut(_ shortcut: KeyShortcut) {
        settings.shortcut = shortcut
        save()
        onShortcutChange?(shortcut)
    }

    func refreshPermissions() {
        accessibilityAllowed = AXIsProcessTrusted()
        messagesReadable = MessagesDatabase.readable()
    }

    private(set) var messagesReadable: Bool = MessagesDatabase.readable()

    func askForAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        accessibilityAllowed = AXIsProcessTrustedWithOptions(options)
    }

    static func openPrivacyPane(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") {
            NSWorkspace.shared.open(url)
        }
    }
}
#endif
