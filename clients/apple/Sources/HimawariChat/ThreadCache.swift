import Foundation
import HimawariCore

struct ThreadCacheSnapshot: Codable {
    var threads: [ThreadSummary] = []
    var texts: [String: String] = [:]
    var details: [String: ThreadDetail] = [:]
}

struct ThreadCache: Sendable {
    let store: LocalStore
    let name = "threads-cache.json"

    func load() -> ThreadCacheSnapshot {
        guard let data = store.read(name), let snapshot = try? JSONDecoder().decode(ThreadCacheSnapshot.self, from: data) else {
            return ThreadCacheSnapshot()
        }
        return snapshot
    }

    func save(_ snapshot: ThreadCacheSnapshot) {
        try? store.write(name, try? JSONEncoder().encode(snapshot))
    }
}
