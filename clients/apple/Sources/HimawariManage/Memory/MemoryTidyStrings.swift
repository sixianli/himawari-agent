import Foundation
import HimawariCore

extension M {
    static var tidyTitle: String { text("整理记忆", ja: "記憶の整理", en: "Memory tidy-up") }
    static var tidyWaiting: String { text("等你看", ja: "見てほしいもの", en: "For you to look at") }
    static var tidyRecent: String { text("最近整理的", ja: "最近の整理", en: "Recently tidied") }
    static var nothingTidied: String {
        text("还没有可以看的整理", ja: "まだ見る整理はありません", en: "Nothing tidied to show yet")
    }
    static var undo: String { text("撤销", ja: "取り消す", en: "Undo") }
    static var openMemory: String { text("看这条", ja: "開く", en: "Open") }
    static var looksFine: String { text("没问题", ja: "問題なし", en: "Looks fine") }
    static var memoryGone: String { text("这条记忆已经不在了", ja: "この記憶はもうありません", en: "This memory is gone") }
    static func howKnownLine(_ basis: String, sources: [String]) -> String {
        guard !sources.isEmpty else { return basis }
        let joined = sources.joined(separator: text("；", ja: "、", en: "; "))
        return basis + "\n" + text("整理自：\(joined)", ja: "元になった記憶：\(joined)", en: "Based on: \(joined)")
    }

    static func reviewReason(_ reason: String) -> String {
        switch reason {
        case "memory_edited": text("它依据的记忆被改了", ja: "根拠の記憶が直されました", en: "A memory it is based on was edited")
        case "memory_superseded": text("它依据的记忆被新说法取代了", ja: "根拠の記憶が新しい内容に置き換わりました", en: "A memory it is based on was replaced by a newer statement")
        case "memory_removed": text("它依据的记忆被删除或归档了", ja: "根拠の記憶が削除かアーカイブされました", en: "A memory it is based on was deleted or archived")
        case "memory_restored": text("它依据的记忆被恢复了", ja: "根拠の記憶が元に戻されました", en: "A memory it is based on was restored")
        case "memory_reclassified": text("它依据的记忆换了分类", ja: "根拠の記憶の分類が変わりました", en: "A memory it is based on changed category")
        case "owner_reported": text("你指出它也该跟着改", ja: "あなたが一緒に直すべきと指摘しました", en: "You said it should change too")
        default: text("它依据的记忆变了", ja: "根拠の記憶が変わりました", en: "A memory it is based on changed")
        }
    }

    static func tidyAction(_ action: String) -> String {
        switch action {
        case "merge": text("合并", ja: "統合", en: "Merged")
        case "supersede": text("取代", ja: "置き換え", en: "Replaced")
        case "archive": text("归档", ja: "アーカイブ", en: "Archived")
        case "reflect": text("归纳", ja: "要約", en: "Summarized")
        case "hold": text("发现说法不一", ja: "食い違いを発見", en: "Found differing statements")
        default: text("整理", ja: "整理", en: "Tidied")
        }
    }

    static func tidyRowTitle(_ entry: MemoryTidyEntry) -> String {
        switch entry {
        case .change(let change): change.text
        case .review(let review):
            text(
                "回看对话，涉及 \(review.changes.count) 条记忆",
                ja: "会話の振り返り：記憶 \(review.changes.count) 件",
                en: "Conversation review: \(review.changes.count) memories"
            )
        }
    }

    static func tidyRowDetail(_ entry: MemoryTidyEntry) -> String {
        let label: String
        switch entry {
        case .change(let change): label = tidyAction(change.action)
        case .review: label = text("回看对话", ja: "会話の振り返り", en: "Conversation review")
        }
        guard let date = Timestamp.parse(entry.at) else { return label }
        return "\(shortDate(date)) · \(label)"
    }

    static var confirmUndoTidy: String { text("撤销这次整理", ja: "この整理を取り消す", en: "Undo this tidy-up") }
    static var confirmDismissReview: String { text("这条记忆看过没问题", ja: "この記憶は問題なしとする", en: "Mark this memory as fine") }
}
