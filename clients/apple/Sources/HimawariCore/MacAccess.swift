import Foundation

public enum FolderAccess: String, Codable, Sendable, CaseIterable {
    case read
    case readWrite
}

public struct FolderGrant: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let path: String
    public var access: FolderAccess
    public let bookmark: Data?

    public init(id: String = OutgoingMessage.newId(), path: String, access: FolderAccess, bookmark: Data? = nil) {
        self.id = id
        self.path = path
        self.access = access
        self.bookmark = bookmark
    }

    public var name: String { URL(fileURLWithPath: path).lastPathComponent }
}

public struct AppGrant: Codable, Sendable, Equatable, Identifiable {
    public let bundleId: String
    public let name: String
    public var id: String { bundleId }

    public init(bundleId: String, name: String) {
        self.bundleId = bundleId
        self.name = name
    }
}

public struct KeyShortcut: Codable, Sendable, Equatable {
    public static let optionModifier: UInt32 = 1 << 11
    public static let commandModifier: UInt32 = 1 << 8
    public static let shiftModifier: UInt32 = 1 << 9
    public static let controlModifier: UInt32 = 1 << 12
    public static let spaceKeyCode: UInt32 = 49

    public let keyCode: UInt32
    public let modifiers: UInt32
    public let key: String

    public init(keyCode: UInt32, modifiers: UInt32, key: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.key = key
    }

    public static let optionSpace = KeyShortcut(keyCode: spaceKeyCode, modifiers: optionModifier, key: "space")

    public var hasModifier: Bool {
        modifiers & (Self.optionModifier | Self.commandModifier | Self.controlModifier) != 0
    }

    public var modifierSymbols: String {
        var symbols = ""
        if modifiers & Self.controlModifier != 0 { symbols += "⌃" }
        if modifiers & Self.optionModifier != 0 { symbols += "⌥" }
        if modifiers & Self.shiftModifier != 0 { symbols += "⇧" }
        if modifiers & Self.commandModifier != 0 { symbols += "⌘" }
        return symbols
    }
}

public struct MacAccessSettings: Codable, Sendable, Equatable {
    public var folders: [FolderGrant]
    public var apps: [AppGrant]
    public var seesFrontmost: Bool
    public var seesMessages: Bool
    public var shortcut: KeyShortcut
    public var messagesAfterRow: Int64?

    public init(folders: [FolderGrant] = [], apps: [AppGrant] = [], seesFrontmost: Bool = true, seesMessages: Bool = false, shortcut: KeyShortcut = .optionSpace) {
        self.folders = folders
        self.apps = apps
        self.seesFrontmost = seesFrontmost
        self.seesMessages = seesMessages
        self.shortcut = shortcut
    }

    public mutating func setSeesMessages(_ on: Bool) {
        seesMessages = on
        if !on { messagesAfterRow = nil }
    }

    @discardableResult
    public mutating func moveMessagesCursor(from expected: Int64?, to row: Int64) -> Bool {
        guard seesMessages, messagesAfterRow == expected else { return false }
        messagesAfterRow = row
        return true
    }

    public mutating func add(_ grant: FolderGrant) {
        let path = PathPolicy.realPath(grant.path)
        folders.removeAll { PathPolicy.realPath($0.path) == path }
        folders.append(grant)
        folders.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    }

    public mutating func add(_ app: AppGrant) {
        apps.removeAll { $0.bundleId == app.bundleId }
        apps.append(app)
        apps.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    public func allowsApp(_ bundleId: String) -> Bool {
        apps.contains { $0.bundleId == bundleId }
    }
}

public enum PathUse: Sendable {
    case read
    case write
}

public enum PathDecision: Sendable, Equatable {
    case allowed(grantId: String, realPath: String)
    case outsideAllowedFolders(realPath: String)
    case readOnly(grantId: String, realPath: String)
    case notAbsolute
}

public enum PathPolicy {
    public static func realPath(_ path: String) -> String {
        let components = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        var existing = components.count
        while existing > 0 {
            if let resolved = systemRealPath("/" + components.prefix(existing).joined(separator: "/")) {
                return appending(components.suffix(from: existing), to: resolved)
            }
            existing -= 1
        }
        return appending(components[...], to: "/")
    }

    private static func systemRealPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private static func appending(_ rest: ArraySlice<String>, to base: String) -> String {
        var parts = base.split(separator: "/").map(String.init)
        for part in rest {
            switch part {
            case ".": continue
            case "..": if !parts.isEmpty { parts.removeLast() }
            default: parts.append(part)
            }
        }
        return "/" + parts.joined(separator: "/")
    }

    public static func contains(_ folder: String, _ path: String) -> Bool {
        let base = folder.split(separator: "/")
        let target = path.split(separator: "/")
        return target.count >= base.count && Array(target.prefix(base.count)) == base
    }

    public static func decide(_ path: String, use: PathUse, grants: [FolderGrant]) -> PathDecision {
        guard path.hasPrefix("/") else { return .notAbsolute }
        let real = realPath(path)
        let matching = grants
            .map { (grant: $0, folder: realPath($0.path)) }
            .filter { contains($0.folder, real) }
            .sorted { $0.folder.count > $1.folder.count }
        guard let nearest = matching.first else { return .outsideAllowedFolders(realPath: real) }
        if use == .write, nearest.grant.access != .readWrite {
            return .readOnly(grantId: nearest.grant.id, realPath: real)
        }
        return .allowed(grantId: nearest.grant.id, realPath: real)
    }
}

public enum URLDecision: Sendable, Equatable {
    case allowed(URL)
    case notHTTPS
    case hostNotAllowed(String)
    case invalid
}

public enum URLPolicy {
    public static func decide(_ text: String, allowedHosts: [String]) -> URLDecision {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased() else { return .invalid }
        guard scheme == "https" else { return .notHTTPS }
        guard url.user == nil, url.password == nil, let host = url.host?.lowercased(), !host.isEmpty else { return .invalid }
        let allowed = allowedHosts.map { $0.lowercased() }
        guard allowed.contains(where: { host == $0 || host.hasSuffix("." + $0) }) else { return .hostNotAllowed(host) }
        return .allowed(url)
    }
}
