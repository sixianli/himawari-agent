import Foundation

public struct MemoryClassifyItem: Decodable, Sendable, Equatable {
    public let contentRef: String
    public let category: String
    public let classification: String
    public let topic: String?
    public let failed: Bool
}

public struct MemoryClassifyResult: Decodable, Sendable, Equatable {
    public let items: [MemoryClassifyItem]
}

public struct MemoryCreatePlan: Sendable, Equatable {
    public let category: String
    public let sensitive: Bool
    public let topic: String?

    public static func make(_ item: MemoryClassifyItem?, contentRef: String) -> MemoryCreatePlan {
        guard let item, item.contentRef == contentRef, !item.failed else {
            return MemoryCreatePlan(category: "other", sensitive: true, topic: "other")
        }
        let sensitive = item.classification == "sensitive" || item.category == "health" || item.category == "finance"
        guard sensitive else { return MemoryCreatePlan(category: item.category, sensitive: false, topic: nil) }
        let topic: String
        if item.classification == "sensitive", let given = item.topic {
            topic = given
        } else {
            topic = item.category == "health" || item.category == "finance" ? item.category : "other"
        }
        return MemoryCreatePlan(category: item.category, sensitive: true, topic: topic)
    }
}
