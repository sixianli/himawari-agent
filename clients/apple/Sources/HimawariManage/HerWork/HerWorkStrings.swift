import Foundation
import HimawariCore
import HimawariDesign

extension M {
    static var whyHide: String { text("收起", ja: "閉じる", en: "Hide") }
    static var whyTitle: String { text("为什么说这个", ja: "なぜ伝えたか", en: "Why Himawari Said This") }
    static var whyCause: String { text("起因", ja: "きっかけ", en: "What Started It") }
    static var whyJudgment: String { text("Himawari 的判断", ja: "Himawari の判断", en: "Himawari’s Reasoning") }
    static var whyYouThink: String { text("这条提醒有用吗？", ja: "この通知は役に立ちましたか？", en: "Was This Useful?") }
    static var whyLoadFailed: String { text("没读到原因，稍后再试", ja: "理由を読み込めませんでした。あとでもう一度", en: "Couldn't load the reason. Try again later") }
    static var whySaveFailed: String { text("没存上，再选一次", ja: "保存できませんでした。もう一度選んでください", en: "Couldn't save. Choose again") }
    static var whyPushed: String { text("也推送到了手机", ja: "スマホにも通知しました", en: "Also sent to your phone") }

    static func rating(_ rating: SpokenRating) -> String {
        switch rating {
        case .useful: text("有用", ja: "役に立った", en: "Useful")
        case .unneeded: text("不需要", ja: "不要だった", en: "Not Needed")
        }
    }

    static func causeKind(_ kind: SpokenExplanation.Cause.Kind) -> String {
        switch kind {
        case .mail: text("一封邮件", ja: "メール", en: "An email")
        case .reminder: text("到点的提醒", ja: "時間になったリマインダー", en: "A reminder came due")
        case .memory: text("一条新记忆", ja: "新しい記憶", en: "A new memory")
        case .timer: text("到点的定时任务", ja: "時間になったタイマー", en: "A timer came due")
        case .perception: text("Himawari 感知到的事", ja: "Himawari が感じ取ったこと", en: "Something Himawari sensed")
        case .subthread: text("后台办完的事", ja: "裏で終わった作業", en: "Background work finished")
        case .other: text("一件新事", ja: "新しい出来事", en: "Something new")
        }
    }

    static var filesTitle: String { text("照片和文件", ja: "写真とファイル", en: "Photos and Files") }
    static var filesSearch: String { text("搜文件名", ja: "ファイル名を検索", en: "Search file names") }
    static var filesFilter: String { text("筛选", ja: "絞り込み", en: "Filter") }
    static var filesEmpty: String { text("还没有文件", ja: "まだファイルはありません", en: "No Files Yet") }
    static var filesEmptyDetail: String { text("Himawari 做出的文件和你发的附件都会在这里。", ja: "Himawari が作ったファイルとあなたが送った添付ファイルがここに表示されます。", en: "Files Himawari makes and attachments you send will show up here.") }
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

    static func fileIcon(_ kind: OwnerFile.Kind) -> IconName {
        switch kind {
        case .document: .fileText
        case .data: .fileSpreadsheet
        case .image: .photo
        case .web: .world
        case .code: .code
        case .pdf: .fileText
        case .other: .fileText
        }
    }
}
