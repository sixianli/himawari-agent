import Foundation

public final class TextMemo<Value>: @unchecked Sendable {
    private final class Box {
        let value: Value
        init(_ value: Value) { self.value = value }
    }

    private let cache = NSCache<NSString, Box>()

    public init(limit: Int) {
        cache.countLimit = limit
    }

    public func value(for key: String, make: (String) -> Value) -> Value {
        if let hit = cache.object(forKey: key as NSString) { return hit.value }
        let made = make(key)
        cache.setObject(Box(made), forKey: key as NSString)
        return made
    }
}
