#if DEBUG
import Foundation
import HimawariChat
import HimawariCore

@MainActor
enum SearchDemo {
    static let suggestions = [
        "我下周三晚上有空吗",
        "田中说过周五的会改到几点",
        "上次订大阪的酒店是哪家",
    ]

    static let answered = SearchAnswer(
        state: .answered,
        query: "田中说过周五的会改到几点",
        answer: "改到下午 3 点了。",
        basis: [SearchBasis(kind: .conversation, threadId: DemoChatFixtures.osakaThreadId, label: "田中今天 15:42 的邮件里写的：周五的会改到 15:00。")]
    )

    static let empty = SearchAnswer(state: .notFound, query: "我养过猫吗", notFoundText: "没有找到相关的内容。")

    static var first: SearchModel {
        SearchModel(suggestions: suggestions)
    }

    static var answer: SearchModel {
        SearchModel(suggestions: suggestions, answer: answered)
    }

    static var nothing: SearchModel {
        SearchModel(suggestions: suggestions, answer: empty)
    }
}
#endif
