import Foundation

public struct ReloadGate<Key: Hashable & Sendable>: Sendable {
    private var running: Set<Key> = []
    private var again: Set<Key> = []

    public init() {}

    public mutating func begin(_ key: Key) -> Bool {
        guard running.insert(key).inserted else {
            again.insert(key)
            return false
        }
        again.remove(key)
        return true
    }

    public mutating func finish(_ key: Key) -> Bool {
        if again.remove(key) != nil { return true }
        running.remove(key)
        return false
    }

    public mutating func cancel(_ key: Key) {
        again.remove(key)
        running.remove(key)
    }
}
