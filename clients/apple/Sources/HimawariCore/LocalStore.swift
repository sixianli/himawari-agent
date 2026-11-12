import Foundation

public protocol LocalStore: Sendable {
    func read(_ name: String) -> Data?
    func contains(_ name: String) -> Bool
    func write(_ name: String, _ data: Data?) throws
    func removeAll() throws
}

public final class FileLocalStore: LocalStore, @unchecked Sendable {
    private let directory: URL
    private let lock = NSLock()
    private var retired = false

    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = directory
        try? url.setResourceValues(values)
    }

    public static func applicationSupport(named name: String) throws -> FileLocalStore {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return try FileLocalStore(directory: base.appendingPathComponent(name, isDirectory: true))
    }

    public func read(_ name: String) -> Data? {
        lock.withLock { try? Data(contentsOf: directory.appendingPathComponent(name)) }
    }

    public func contains(_ name: String) -> Bool {
        lock.withLock { FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path) }
    }

    public func write(_ name: String, _ data: Data?) throws {
        try lock.withLock {
            if retired { throw LocalStoreError.retired }
            let url = directory.appendingPathComponent(name)
            guard let data else {
                try? FileManager.default.removeItem(at: url)
                return
            }
            #if os(iOS) || os(watchOS)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: url, options: [.atomic])
            #endif
        }
    }

    public func removeAll() throws {
        try lock.withLock {
            let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            for name in names { try FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
        }
    }

    public func retire() throws {
        try lock.withLock {
            let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            for name in names { try FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
            retired = true
        }
    }
}

public final class MemoryLocalStore: LocalStore, @unchecked Sendable {
    private let lock = NSLock()
    private var files: [String: Data] = [:]

    public init() {}

    public func read(_ name: String) -> Data? {
        lock.withLock { files[name] }
    }

    public func contains(_ name: String) -> Bool {
        lock.withLock { files[name] != nil }
    }

    public func write(_ name: String, _ data: Data?) throws {
        lock.withLock { files[name] = data }
    }

    public func removeAll() throws {
        lock.withLock { files.removeAll() }
    }
}

public struct StoredCursor: CursorStore {
    private let store: LocalStore
    private let name: String

    public init(store: LocalStore, name: String = "stream-cursor") {
        self.store = store
        self.name = name
    }

    public func load() -> String? {
        store.read(name).flatMap { String(data: $0, encoding: .utf8) }.flatMap { $0.isEmpty ? nil : $0 }
    }

    public func save(_ cursor: String?) {
        try? store.write(name, cursor.map { Data($0.utf8) })
    }
}
