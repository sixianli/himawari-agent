import Foundation
import HimawariCore

extension M {
    static var whyTitle: String { text("为什么说这个", ja: "なぜ伝えたか", en: "Why She Said This") }
    static var whyCause: String { text("起因", ja: "きっかけ", en: "What Started It") }
    static var whyJudgment: String { text("她的判断", ja: "彼女の判断", en: "Her Reasoning") }
    static var whyYouThink: String { text("你觉得", ja: "あなたの評価", en: "Your Take") }
    static var whyLoadFailed: String { text("没读到原因，稍后再试", ja: "理由を読み込めませんでした。あとでもう一度", en: "Couldn't load the reason. Try again later") }
    static var whySaveFailed: String { text("没存上，再选一次", ja: "保存できませんでした。もう一度選んでください", en: "Couldn't save. Choose again") }
    static var whyPushed: String { text("推送到了手机", ja: "スマホに通知しました", en: "Sent to your phone") }

    static func rating(_ rating: SpokenRating) -> String {
        switch rating {
        case .useful: text("说得对", ja: "役に立った", en: "Worth Saying")
        case .unneeded: text("不用说", ja: "不要だった", en: "Not Needed")
        }
    }

    static func causeKind(_ kind: SpokenExplanation.Cause.Kind) -> String {
        switch kind {
        case .mail: text("一封邮件", ja: "メール", en: "An email")
        case .reminder: text("到点的提醒", ja: "時間になったリマインダー", en: "A reminder came due")
        case .memory: text("一条新记忆", ja: "新しい記憶", en: "A new memory")
        case .timer: text("到点的定时任务", ja: "時間になったタイマー", en: "A timer came due")
        case .perception: text("她感知到的事", ja: "彼女が感じ取ったこと", en: "Something she sensed")
        case .subthread: text("后台办完的事", ja: "裏で終わった作業", en: "Background work finished")
        case .other: text("一件新事", ja: "新しい出来事", en: "Something new")
        }
    }

    static var herWorkTitle: String { text("她做得怎么样", ja: "彼女の調子", en: "How She's Doing") }
    static func statsSpan(_ span: StatsSpan) -> String {
        switch span {
        case .week: text("这周", ja: "今週", en: "This Week")
        case .fourWeeks: text("过去 4 周", ja: "過去 4 週間", en: "Past 4 Weeks")
        }
    }

    static func statsDays(_ span: StatsSpan) -> Int { span == .week ? 7 : 28 }

    static var statsSpoken: String { text("她主动说了几次", ja: "自分から伝えた回数", en: "Times She Spoke Up") }
    static func statsSpokenDefinition(_ span: StatsSpan) -> String {
        let days = statsDays(span)
        return text("最近 \(days) 天她主动发到主对话的消息条数，和再往前 \(days) 天比", ja: "直近 \(days) 日間に彼女が自分からメインの会話に送ったメッセージの数。その前の \(days) 日間と比べます", en: "Messages she sent to the main chat on her own in the last \(days) days, compared with the \(days) days before")
    }

    static func statsRateDefinition(_ rating: SpokenRating) -> String {
        let label = M.rating(rating)
        return text("你在“为什么说这个”里选了“\(label)”的条数 ÷ 你评过的条数", ja: "「なぜ伝えたか」で「\(label)」を選んだ数 ÷ 評価した数", en: "Messages you marked “\(label)” in “Why She Said This” ÷ messages you rated")
    }

    static func statsRated(_ rated: Int, of total: Int) -> String {
        text("评了 \(rated) / \(total) 条", ja: "\(total) 件中 \(rated) 件を評価", en: "Rated \(rated) of \(total)")
    }

    static func statsTooFew(_ rated: Int) -> String {
        text("评得太少（\(rated) 条）", ja: "評価が少なすぎます（\(rated) 件）", en: "Too few ratings (\(rated))")
    }

    static var statsRecall: String { text("记得准不准", ja: "記憶の正確さ", en: "Memory Accuracy") }
    static func statsRecallDefinition(_ date: Date) -> String {
        let day = date.formatted(date: .abbreviated, time: .omitted)
        return text("用你的真实记忆出的固定一组题里答对的比例，\(day) 测的，和上一次比", ja: "あなたの実際の記憶から作った固定の問題で正解した割合。\(day) に測定し、前回と比べます", en: "Share of a fixed set of questions from your real memories she answered right, checked \(day), compared with the previous check")
    }

    static func statsRecallValue(_ correct: Int, of asked: Int) -> String {
        text("答对 \(correct) / \(asked) 题", ja: "\(asked) 問中 \(correct) 問正解", en: "\(correct) of \(asked) right")
    }

    static var statsLoadFailed: String { text("没读到数字，下拉再试一次", ja: "数字を読み込めませんでした。引っ張って再試行", en: "Couldn't load the numbers. Pull to try again") }
    static var statsUp: String { text("比上一段多", ja: "前の期間より多い", en: "Up from the previous period") }
    static var statsDown: String { text("比上一段少", ja: "前の期間より少ない", en: "Down from the previous period") }
    static var statsSame: String { text("和上一段一样", ja: "前の期間と同じ", en: "Same as the previous period") }

    static var filesTitle: String { text("文件", ja: "ファイル", en: "Files") }
    static var filesSearch: String { text("搜文件名", ja: "ファイル名を検索", en: "Search file names") }
    static var filesFilter: String { text("筛选", ja: "絞り込み", en: "Filter") }
    static var filesEmpty: String { text("还没有文件", ja: "まだファイルはありません", en: "No Files Yet") }
    static var filesEmptyDetail: String { text("她做出的文件和你发的附件都会在这里。", ja: "彼女が作ったファイルとあなたが送った添付ファイルがここに表示されます。", en: "Files she makes and attachments you send will show up here.") }
    static var filesLoadFailed: String { text("没读到文件，下拉再试一次", ja: "ファイルを読み込めませんでした。引っ張って再試行", en: "Couldn't load files. Pull to try again") }
    static var filesOpenFailed: String { text("没打开这个文件", ja: "このファイルを開けませんでした", en: "Couldn't open this file") }
    static var filesShare: String { text("分享", ja: "共有", en: "Share") }
    static var filesFindInChat: String { text("在对话里找到它", ja: "会話で探す", en: "Find in Chat") }
    static var filesDeleted: String { text("已删除", ja: "削除済み", en: "Deleted") }
    static var filesLoadMore: String { text("再看更早的", ja: "さらに前を表示", en: "Show Older") }

    static func filesFrom(_ date: Date, version: Int) -> String {
        let day = date.formatted(.dateTime.month().day())
        let from = text("来自 \(day) 的对话", ja: "\(day) の会話から", en: "From the chat on \(day)")
        guard version > 1 else { return from }
        return from + " · " + text("第 \(version) 版", ja: "第 \(version) 版", en: "Version \(version)")
    }

    static func fileFilter(_ filter: OwnerFileFilter) -> String {
        switch filter {
        case .all: text("全部", ja: "すべて", en: "All")
        case .uploaded: text("我上传的", ja: "自分がアップロード", en: "Uploaded by Me")
        case .kind(let kind):
            switch kind {
            case .document: text("文档", ja: "文書", en: "Documents")
            case .data: text("表格", ja: "表", en: "Spreadsheets")
            case .image: text("图片", ja: "画像", en: "Images")
            case .web: text("网页", ja: "ウェブページ", en: "Web Pages")
            case .code: text("代码", ja: "コード", en: "Code")
            case .pdf: text("PDF", ja: "PDF", en: "PDFs")
            case .other: text("其他", ja: "その他", en: "Other")
            }
        }
    }

    static func fileSymbol(_ kind: OwnerFile.Kind) -> String {
        switch kind {
        case .document: "doc.text"
        case .data: "tablecells"
        case .image: "photo"
        case .web: "globe"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .pdf: "doc.richtext"
        case .other: "doc"
        }
    }
}
