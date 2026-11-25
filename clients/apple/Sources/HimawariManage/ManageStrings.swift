import Foundation
import HimawariCore

enum ManageLanguage: String {
    case zh
    case ja
    case en

    static var current: ManageLanguage {
        ManageLanguage(rawValue: String(Locale.preferredLanguages.first?.prefix(2) ?? "")) ?? .zh
    }
}

enum M {
    static func text(_ zh: String, ja: String, en: String) -> String {
        switch ManageLanguage.current {
        case .zh: zh
        case .ja: ja
        case .en: en
        }
    }

    static var memoryTitle: String { text("记忆", ja: "記憶", en: "Memory") }
    static var remembered: String { text("记住的事", ja: "覚えていること", en: "Remembered") }
    static var rules: String { text("规则", ja: "ルール", en: "Rules") }
    static var search: String { text("搜索", ja: "検索", en: "Search") }
    static var nothingRemembered: String {
        text("还没有记住的事", ja: "まだ覚えていることはありません", en: "Nothing remembered yet")
    }
    static var noRules: String { text("还没有规则", ja: "まだルールはありません", en: "No rules yet") }
    static var loadFailed: String {
        text("没读到，下拉再试一次", ja: "読み込めませんでした。引っ張ってもう一度", en: "Couldn't load. Pull to try again")
    }
    static var inferred: String { text("从记录看出来的", ja: "記録から読み取りました", en: "Inferred from records") }
    static var rulePaused: String { text("停用中", ja: "停止中", en: "Paused") }
    static var ruleNeedsReview: String { text("等你看", ja: "確認待ち", en: "Needs your look") }

    static var back: String { text("返回", ja: "戻る", en: "Back") }
    static var stopRun: String { text("停下这次回答", ja: "この返事を止める", en: "Stop this answer") }
    static var chooseOption: String { text("选这一项", ja: "これを選ぶ", en: "Choose this") }
    static var collapse: String { text("收起", ja: "閉じる", en: "Close") }
    static var herMemory: String { text("她记得的", ja: "覚えていること", en: "What she remembers") }
    static func memorySummary(_ summary: MemorySummary) -> String {
        text(
            "\(summary.memories) 条记忆 · \(summary.topics) 个主题 · \(summary.rules) 条规则",
            ja: "記憶 \(summary.memories) 件 · テーマ \(summary.topics) 個 · ルール \(summary.rules) 件",
            en: "\(summary.memories) memories · \(summary.topics) topics · \(summary.rules) rules"
        )
    }
    static var privacy: String { text("隐私", ja: "プライバシー", en: "Privacy") }
    static var devicesTitle: String { text("设备", ja: "デバイス", en: "Devices") }
    static func approvalsWaiting(_ count: Int) -> String {
        text("等你同意 · \(count) 件", ja: "あなたの同意待ち · \(count) 件", en: "Waiting for you · \(count)")
    }
    static func phoneLine(_ name: String, _ presence: String) -> String { "\(name) · \(presence)" }
    static func pairedSince(_ date: Date) -> String {
        text("\(pairedDay(date))配对", ja: "\(pairedDay(date))にペアリング", en: "Paired \(pairedDay(date))")
    }
    static var disconnectThisIPhone: String { text("断开这台 iPhone", ja: "この iPhone の接続を解除", en: "Disconnect this iPhone") }
    static var quietWhen: String { text("什么时候不响", ja: "鳴らさない時間", en: "When to stay quiet") }
    static var quietAtNight: String { text("晚上不响", ja: "夜は鳴らさない", en: "Quiet at night") }
    static var quietOff: String { text("不设不响的时段", ja: "鳴らさない時間を設けない", en: "No quiet hours") }
    static var quietFrom: String { text("从", ja: "開始", en: "From") }
    static var quietTo: String { text("到", ja: "終了", en: "Until") }
    static func quietNote(end: String) -> String {
        text(
            "这段时间里她的话不响，到 \(end) 再响。要你同意的事照样响，不然那件事会一直卡着。",
            ja: "この間は彼女からの通知を鳴らさず、\(end) に鳴らします。あなたの同意が要ることは鳴ります。止まったままになるからです。",
            en: "During this time her messages stay silent until \(end). Things that need your OK still ring, or they would stay stuck."
        )
    }
    static var quietSayIt: String {
        text(
            "在主对话里说“晚上 11 点以后别推”也一样，会改到这里。别的什么时候推，由她看事情定。",
            ja: "会話で「夜 11 時以降は通知しないで」と言っても同じで、ここに反映されます。それ以外にいつ通知するかは、彼女が内容を見て決めます。",
            en: "Saying \"don't notify me after 11 pm\" in the chat does the same and shows up here. When else to notify, she decides from what's going on."
        )
    }
    static var quietReadOnly: String {
        text(
            "这是在主对话里定的，不止一段，要改就在主对话里说。",
            ja: "会話で決めた複数の時間帯です。変えるときは会話で伝えてください。",
            en: "These were set in the chat and have more than one window. Say it in the chat to change them."
        )
    }
    static func quietSummary(_ hours: QuietHours) -> String {
        guard hours.enabled else { return text("没设不响的时段", ja: "鳴らさない時間なし", en: "No quiet hours") }
        guard hours.editable, let start = ClockTime(hours.start), let end = ClockTime(hours.end) else {
            return text("按主对话里说的时段不响", ja: "会話で決めた時間は鳴らさない", en: "Quiet at the times you set in chat")
        }
        return text(
            "\(start.shortText)–\(end.shortText) 不响",
            ja: "\(start.shortText)–\(end.shortText) は鳴らさない",
            en: "Quiet \(start.shortText)–\(end.shortText)"
        )
    }
    static var letHerSense: String { text("让她感知", ja: "彼女に感じ取らせる", en: "Let Her Sense") }
    static func sensesOn(_ count: Int) -> String { text("\(count) 项开着", ja: "\(count) 項目オン", en: "\(count) on") }
    static var pauseMemory: String { text("暂停记忆", ja: "記憶を一時停止", en: "Pause memory") }
    static var resumeMemory: String { text("恢复记忆", ja: "記憶を再開", en: "Resume memory") }
    static var pauseMemoryDetail: String {
        text("她照常回答，但不记新的", ja: "返事はいつもどおり。新しいことは覚えません", en: "She still answers, but won't remember anything new")
    }
    static var voiceprint: String { text("我的声纹", ja: "自分の声紋", en: "My voiceprint") }
    static var voiceprintDetail: String {
        text("只用来认出是你在说话", ja: "あなたの声だと聞き分けるためだけに使います", en: "Only used to tell that it's you speaking")
    }
    static var voiceprintKept: String { text("已录", ja: "登録済み", en: "Recorded") }
    static var voiceprintNone: String { text("没录", ja: "未登録", en: "Not recorded") }
    static var forgetVoiceprint: String { text("删掉我的声纹？", ja: "声紋を削除しますか？", en: "Delete your voiceprint?") }
    static var forgetVoiceprintConfirm: String { text("删掉", ja: "削除", en: "Delete") }
    static var forgetVoiceprintDetail: String {
        text(
            "删掉后她认不出哪句是你说的，要用时再录一次",
            ja: "削除すると、どれがあなたの声か分からなくなります。必要なときにまた登録してください",
            en: "She won't be able to tell which words are yours until you record it again"
        )
    }

    static var rule: String { text("规则", ja: "ルール", en: "Rule") }
    static var reconfirmRule: String { text("重新确认", ja: "もう一度確認", en: "Confirm again") }
    static var ruleEnforced: String { text("在执行", ja: "実行中", en: "In effect") }
    static var confirmUndoRule: String { text("停用这条规则", ja: "このルールを止める", en: "Pause this rule") }
    static var confirmReconfirmRule: String { text("重新确认这条规则", ja: "このルールをもう一度確認", en: "Confirm this rule again") }

    static func ruleState(_ rule: RuleSummary) -> String {
        if rule.status == "needs_review" { return ruleNeedsReview }
        return rule.enforced ? ruleEnforced : rulePaused
    }

    static func ruleDraft(_ summary: String) -> String {
        text("把这条规则“\(summary)”改成：", ja: "このルール「\(summary)」を次のように変えて：", en: "Change the rule \"\(summary)\" to: ")
    }

    static var close: String { text("关闭", ja: "閉じる", en: "Close") }
    static var howKnown: String { text("怎么知道的", ja: "どうして知っているか", en: "How I know") }
    static var lastUsed: String { text("上次用它", ja: "最後に使ったとき", en: "Last used") }
    static var neverUsed: String { text("还没用过。", ja: "まだ使っていません。", en: "Not used yet.") }
    static var delete: String { text("删除", ja: "削除", en: "Delete") }
    static var edit: String { text("改一改", ja: "直す", en: "Edit") }
    static var save: String { text("存", ja: "保存", en: "Save") }
    static var editNote: String {
        text("改完后，“怎么知道的”会记成你亲手改的", ja: "直したあと、「どうして知っているか」はあなたが直したと記録されます", en: "After you edit, \"How I know\" will say you changed it")
    }
    static var actionFailed: String { text("没办成，再试一次", ja: "できませんでした。もう一度", en: "That didn't go through. Try again") }
    static var confirmDelete: String { text("删除这条记忆", ja: "この記憶を削除", en: "Delete this memory") }
    static var confirmEdit: String { text("改这条记忆", ja: "この記憶を直す", en: "Edit this memory") }

    static func basis(_ basis: MemoryBasis) -> String {
        switch basis {
        case .inferred: return text("从记录看出来的。", ja: "記録から読み取りました。", en: "Inferred from records.")
        case .imported(let source): return imported(source) + text("。", ja: "。", en: ".")
        case .said(let date, let quote):
            let day = date.map(shortDate)
            switch (day, quote) {
            case let (day?, quote?):
                return text("\(day)你说“\(quote)”。", ja: "\(day)に「\(quote)」と言いました。", en: "On \(day) you said \"\(quote)\".")
            case let (nil, quote?):
                return text("你说“\(quote)”。", ja: "「\(quote)」と言いました。", en: "You said \"\(quote)\".")
            case let (day?, nil):
                return text("\(day)你说的。", ja: "\(day)にあなたが言いました。", en: "You said it on \(day).")
            case (nil, nil):
                return text("你说的。", ja: "あなたが言いました。", en: "You said it.")
            }
        }
    }

    static func lastUsed(_ date: Date?) -> String {
        guard let date else { return neverUsed }
        return text("\(shortDate(date))。", ja: "\(shortDate(date))。", en: "\(shortDate(date)).")
    }

    static func toldBy(_ date: String?) -> String {
        guard let date else { return text("你说的", ja: "あなたが言った", en: "You said") }
        return text("你说的 · \(date)", ja: "あなたが言った · \(date)", en: "You said · \(date)")
    }

    static func imported(_ source: String) -> String {
        let name = switch source {
        case "codex": "Codex"
        case "assistant": text("别的助手", ja: "ほかのアシスタント", en: "Another assistant")
        default: "Himawari"
        }
        return text("\(name) 存进来的", ja: "\(name) が保存", en: "Saved by \(name)")
    }

    static func category(_ name: String) -> String {
        switch name {
        case "identity": text("关于你", ja: "あなたについて", en: "About you")
        case "preference": text("喜好", ja: "好み", en: "Preferences")
        case "relationship": text("人", ja: "人", en: "People")
        case "goal": text("目标", ja: "目標", en: "Goals")
        case "project": text("工作", ja: "仕事", en: "Work")
        case "rule": text("规矩", ja: "決まりごと", en: "House rules")
        case "health": text("身体", ja: "からだ", en: "Health")
        case "finance": text("钱", ja: "お金", en: "Money")
        case "event": text("日子", ja: "予定", en: "Dates")
        default: text("其他", ja: "その他", en: "Other")
        }
    }

    static func shortDate(_ date: Date) -> String {
        let style = Date.FormatStyle.dateTime.month(.defaultDigits).day()
        return date.formatted(style.locale(Locale(identifier: ManageLanguage.current == .en ? "en_US" : ManageLanguage.current == .ja ? "ja_JP" : "zh_CN")))
    }

    static func pairedDay(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.month, .day], from: date)
        let month = parts.month ?? 1
        let day = parts.day ?? 1
        return text("\(month) 月 \(day) 日", ja: "\(month)月\(day)日", en: date.formatted(.dateTime.month(.abbreviated).day().locale(Locale(identifier: "en_US"))))
    }

    static var server: String { text("服务器", ja: "サーバー", en: "Server") }

    static var thisIPhone: String { text("这台 iPhone", ja: "この iPhone", en: "This iPhone") }

    static func relative(_ date: Date) -> String {
        let formatted = date.formatted(.relative(presentation: .named).locale(locale))
        guard ManageLanguage.current == .zh else { return formatted }
        return formatted.replacingOccurrences(of: #"(\d)(\p{Han})"#, with: "$1 $2", options: .regularExpression)
    }

    static func presence(_ presence: DevicePresence) -> String {
        switch presence {
        case .connected: text("连着", ja: "つながっています", en: "Connected")
        case .justNow: text("刚刚", ja: "たった今", en: "Just now")
        case .seen(let date):
            relative(date)
        case .neverSeen: text("还没连过", ja: "まだつながっていません", en: "Never connected")
        case .waitingForConfirmation: text("等确认", ja: "確認待ち", en: "Waiting to confirm")
        }
    }

    static var deviceName: String { text("名字", ja: "名前", en: "Name") }
    static var deviceNow: String { text("现在", ja: "いま", en: "Now") }
    static var pairedOn: String { text("配对于", ja: "ペアリング日", en: "Paired") }
    static var deviceVersion: String { text("版本", ja: "バージョン", en: "Version") }

    static func channel(_ value: String) -> String? {
        switch value {
        case "direct": text("自用直装", ja: "直接インストール", en: "Direct install")
        case "testflight": "TestFlight"
        case "app_store": "App Store"
        case "mac_direct": text("Mac 直装", ja: "Mac 直接インストール", en: "Mac direct install")
        default: nil
        }
    }

    static var removeDevice: String { text("移除这台设备", ja: "このデバイスを外す", en: "Remove this device") }
    static func confirmRemove(_ name: String) -> String { text("移除 \(name)", ja: "\(name) を外す", en: "Remove \(name)") }
    static func confirmRename(_ name: String) -> String { text("把名字改成 \(name)", ja: "名前を \(name) に変える", en: "Rename to \(name)") }
    static var renameTitle: String { text("给这台设备起个名字", ja: "このデバイスに名前をつける", en: "Name this device") }
    static var ok: String { text("好", ja: "OK", en: "OK") }
    static var lastConnected: String { text("上次连上", ja: "最後の接続", en: "Last connected") }
    static var cancel: String { text("取消", ja: "キャンセル", en: "Cancel") }

    private static var locale: Locale {
        Locale(identifier: ManageLanguage.current == .en ? "en_US" : ManageLanguage.current == .ja ? "ja_JP" : "zh_CN")
    }

    static var yourWords: String { text("你的原话", ja: "あなたの言葉", en: "Your words") }
    static var notificationsTitle: String { text("通知", ja: "通知", en: "Notifications") }

    static var quoteChangedLater: String { text("这句话后来改过", ja: "この言葉はあとで変わりました", en: "You changed this later") }
    static var lastUsedRule: String { text("上次用上", ja: "最後に使ったとき", en: "Last used") }
    static var pauseRule: String { text("停用", ja: "止める", en: "Pause") }

    static func quoted(_ quote: String) -> String {
        text("“\(quote)”", ja: "「\(quote)」", en: "\u{201C}\(quote)\u{201D}")
    }

    static func changedTimes(_ count: Int) -> String {
        text("改过 \(count) 次", ja: "\(count) 回変更", en: count == 1 ? "Changed once" : "Changed \(count) times")
    }

    static func dayAndTime(_ date: Date, now: Date, calendar: Calendar) -> String {
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
        if calendar.isDate(date, inSameDayAs: now) {
            return text("今天 \(time)", ja: "今日 \(time)", en: "Today \(time)")
        }
        return "\(shortDate(date)) \(time)"
    }
}
