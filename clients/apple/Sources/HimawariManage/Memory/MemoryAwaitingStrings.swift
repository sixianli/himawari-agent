import Foundation
import HimawariCore

extension M {
    static var awaitingTitle: String { text("待你确认", ja: "確認待ち", en: "To confirm") }

    static func awaitingTab(_ count: Int) -> String {
        count > 0 ? "\(awaitingTitle) \(count)" : awaitingTitle
    }

    static var nothingAwaiting: String {
        text("没有等你确认的事", ja: "確認待ちはありません", en: "Nothing to confirm")
    }
    static var recentlyHandled: String { text("可以撤销的", ja: "取り消せるもの", en: "You can undo") }
    static var undo: String { text("撤销", ja: "取り消す", en: "Undo") }
    static var remember: String { text("记住", ja: "覚える", en: "Remember") }
    static var dontRemember: String { text("不记", ja: "覚えない", en: "Don't") }
    static var keepIt: String { text("保存", ja: "保存", en: "Keep") }
    static var notSame: String { text("不是", ja: "別の人", en: "No") }
    static var sameOne: String { text("是同一个人", ja: "同じ人", en: "Same person") }
    static var stopReminding: String { text("不再提醒", ja: "もう通知しない", en: "Stop") }
    static var snoozeReminder: String { text("1 小时后", ja: "1時間後", en: "In 1 hour") }
    static var openMemory: String { text("看这条", ja: "開く", en: "Open") }
    static var looksFine: String { text("没问题", ja: "問題なし", en: "Looks fine") }
    static var memoryGone: String { text("这条记忆已经不在了", ja: "この記憶はもうありません", en: "This memory is gone") }
    static var basedOn: String { text("整理自", ja: "元になった記憶", en: "Based on") }

    static func hiddenExternal(_ count: Int) -> String {
        text("还有 \(count) 条，处理完这些再看", ja: "あと \(count) 件。これを片付けると出ます", en: "\(count) more after these")
    }

    static func topic(_ name: String) -> String {
        switch name {
        case "health": text("健康", ja: "健康", en: "health")
        case "finance": text("财务", ja: "お金", en: "money")
        case "beliefs": text("信仰", ja: "信条", en: "beliefs")
        case "intimacy": text("私密", ja: "プライベート", en: "intimate matters")
        case "third_party": text("别人的事", ja: "他の人のこと", en: "someone else")
        case "location": text("位置", ja: "位置", en: "location")
        case "legal": text("法律", ja: "法律", en: "legal matters")
        default: text("敏感信息", ja: "センシティブな内容", en: "sensitive info")
        }
    }

    static func approvalStatus(_ request: MemoryApprovalRequest) -> String {
        text("涉及\(topic(request.topic))，点头才会用", ja: "\(topic(request.topic)) に関わる内容。承認で使われます", en: "About \(topic(request.topic)). Used once you agree")
    }

    static func externalStatus(_ proposal: MemoryExternalProposal) -> String {
        let source = text("自称 \(proposal.client)", ja: "\(proposal.client) と名乗っています", en: "Says it's \(proposal.client)")
        guard proposal.dataClassification == "sensitive" else { return source }
        return text("\(source)，按敏感记忆存", ja: "\(source)。センシティブとして保存", en: "\(source). Saved as sensitive")
    }

    static func personQuestion(_ question: MemoryPersonQuestion) -> String {
        text("“\(question.name)”和“\(question.candidateName)”是同一个人吗？", ja: "「\(question.name)」と「\(question.candidateName)」は同じ人ですか？", en: "Are \(question.name) and \(question.candidateName) the same person?")
    }

    static var personStatus: String { text("拿不准，先问你", ja: "確信がないので確認です", en: "Not sure, so asking") }

    static func reminderStatus(_ reminder: MemoryReminder, now: Date = Date()) -> String? {
        guard let due = Timestamp.parse(reminder.dueAt) else { return nil }
        let when = dayAndTime(due, now: now, calendar: .current)
        return text("到期 \(when)", ja: "期限 \(when)", en: "Due \(when)")
    }

    static func reviewReason(_ reason: String) -> String {
        switch reason {
        case "memory_edited": text("它依据的记忆被改了", ja: "根拠の記憶が直されました", en: "A memory it rests on was edited")
        case "memory_superseded": text("它依据的记忆被新说法取代了", ja: "根拠の記憶が新しい内容に置き換わりました", en: "A memory it rests on was replaced")
        case "memory_removed": text("它依据的记忆被删了或归档了", ja: "根拠の記憶が削除かアーカイブされました", en: "A memory it rests on was removed")
        case "memory_restored": text("它依据的记忆被恢复了", ja: "根拠の記憶が元に戻されました", en: "A memory it rests on was restored")
        case "memory_reclassified": text("它依据的记忆换了分类", ja: "根拠の記憶の分類が変わりました", en: "A memory it rests on changed category")
        case "owner_reported": text("你说它也该跟着改", ja: "あなたが一緒に直すべきと指摘しました", en: "You said it should change too")
        default: text("它依据的记忆变了", ja: "根拠の記憶が変わりました", en: "A memory it rests on changed")
        }
    }

    static func tidyAction(_ action: String) -> String {
        switch action {
        case "merge": text("合并了重复", ja: "重複を統合", en: "Merged duplicates")
        case "supersede": text("换成了新说法", ja: "新しい内容に置き換え", en: "Replaced by a newer one")
        case "archive": text("不再用了", ja: "使わなくなりました", en: "Set aside")
        case "hold": text("发现说法不一", ja: "食い違いを発見", en: "Found differing statements")
        default: text("整理了", ja: "整理しました", en: "Tidied")
        }
    }

    static func conversationReview(_ review: MemoryConversationReview) -> String {
        text("回看了一段对话，动了 \(review.changes.count) 条", ja: "会話を振り返り、\(review.changes.count) 件を更新", en: "Reviewed a conversation, touched \(review.changes.count)")
    }

    static func externalBatch(_ batch: MemoryExternalBatch) -> String {
        text("其他 agent 的一批：存 \(batch.committed) 条，不要 \(batch.rejected) 条", ja: "他の agent の一括：保存 \(batch.committed) 件、見送り \(batch.rejected) 件", en: "From other agents: \(batch.committed) kept, \(batch.rejected) declined")
    }

    static var addMemory: String { text("记住一件事", ja: "覚えてほしいこと", en: "Remember something") }
    static var addPlaceholder: String {
        text("例如：周末早上 9 点前不要提醒我", ja: "例：週末の朝 9 時前は通知しないで", en: "For example: no reminders before 9 am on weekends")
    }

    static var confirmApproveMemory: String { text("记住这条记忆", ja: "この記憶を覚える", en: "Remember this memory") }
    static var confirmDeclineMemory: String { text("不记这条记忆", ja: "この記憶を覚えない", en: "Don't remember this memory") }
    static var confirmKeepExternal: String { text("保存其他 agent 送来的记忆", ja: "他の agent の記憶を保存", en: "Keep a memory from another agent") }
    static var confirmDeclineExternal: String { text("不要其他 agent 送来的记忆", ja: "他の agent の記憶を見送る", en: "Decline a memory from another agent") }
    static var confirmUndoBatch: String { text("撤销这一批", ja: "この一括を取り消す", en: "Undo this batch") }
    static var confirmPerson: String { text("回答是不是同一个人", ja: "同じ人かどうかに答える", en: "Answer whether they are the same person") }
    static var confirmReminder: String { text("处理这条提醒", ja: "このリマインダーを処理", en: "Handle this reminder") }
    static var confirmUndoTidy: String { text("撤销这次整理", ja: "この整理を取り消す", en: "Undo this tidy-up") }
    static var confirmDismissReview: String { text("这条记忆看过没问题", ja: "この記憶は問題なしとする", en: "Mark this memory as fine") }
    static var confirmCreateMemory: String { text("新记一条记忆", ja: "新しい記憶を追加", en: "Add a memory") }
}
