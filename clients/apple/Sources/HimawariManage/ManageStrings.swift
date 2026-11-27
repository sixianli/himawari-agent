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
    static var searchPrompt: String { text("搜记住的事和规则", ja: "覚えていることとルールを検索", en: "Search memories and rules") }
    static var searchFailed: String { text("现在搜不了，稍后再试", ja: "いまは検索できません。あとでもう一度", en: "Search isn't available right now. Try again later") }
    static func noSearchResults(_ query: String) -> String { text("没有找到“\(query)”", ja: "「\(query)」は見つかりません", en: "Nothing found for “\(query)”") }
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

    static var stopRun: String { text("停下这次回答", ja: "この返事を止める", en: "Stop this answer") }
    static var chooseOption: String { text("选这一项", ja: "これを選ぶ", en: "Choose this") }
    static var done: String { text("完成", ja: "完了", en: "Done") }
    static var herPage: String { text("Himawari", ja: "Himawari", en: "Himawari") }
    static var herMemory: String { text("Himawari 记得的", ja: "覚えていること", en: "What Himawari remembers") }
    static func memorySummary(_ summary: MemorySummary) -> String {
        text(
            "\(summary.memories) 条记忆 · \(summary.rules) 条规则",
            ja: "記憶 \(summary.memories) 件 · ルール \(summary.rules) 件",
            en: "\(summary.memories) memories · \(summary.rules) rules"
        )
    }
    static var privacy: String { text("隐私", ja: "プライバシー", en: "Privacy") }
    static var devicesTitle: String { text("设备", ja: "デバイス", en: "Devices") }
    static var nameTitle: String { text("你的称呼", ja: "呼び名", en: "What Himawari calls you") }
    static var namePlaceholder: String { text("比如 Andy", ja: "例：Andy", en: "For example, Andy") }
    static var nameFooter: String {
        text(
            "Himawari 跟你说话时用这个称呼。留空就不用称呼。最多 40 个字。",
            ja: "話しかけるときにこの名前で呼びます。空欄なら名前で呼びません。40 文字まで。",
            en: "Himawari uses this name when talking to you. Leave it empty for no name. Up to 40 characters."
        )
    }
    static var nameUnset: String { text("未设置", ja: "未設定", en: "Not set") }
    static var modelTitle: String { text("Himawari 用的模型", ja: "Himawari が使うモデル", en: "Himawari's model") }
    static var modelFooter: String {
        text(
            "从下一条消息起，Himawari 用选中的模型回答你从 App 发的消息。选项由服务器提供。",
            ja: "次のメッセージから、アプリから送ったメッセージに選んだモデルで答えます。選択肢はサーバーから届きます。",
            en: "From your next message, Himawari answers what you send from the app with this model. The list comes from the server."
        )
    }
    static var priceNote: String {
        text(
            "价格是 Magpie 清单里的标价（美元 / 百万 token）。“便宜”“适中”“较贵”按清单里所有有标价的模型，用“输入价 + 输出价”从低到高平分三档。已付费套餐内使用不另外扣费，但越贵越快用完套餐额度。",
            ja: "価格は Magpie の一覧にある定価です（米ドル / 100 万トークン）。「安い」「中程度」「高め」は、定価のあるモデルを「入力 + 出力」の安い順に三等分したものです。契約済みプランの範囲内なら追加料金はかかりませんが、高いほど早く枠を使い切ります。",
            en: "Prices are list prices from Magpie (USD per million tokens). Cheap, Mid and Pricey split every priced model into thirds by input plus output price. Use inside a paid plan costs nothing extra, but pricier models use up the plan sooner."
        )
    }
    static var thinkingTitle: String { text("思考深度", ja: "考える深さ", en: "Thinking depth") }
    static var thinkingFooter: String {
        text("想得越深，回答越慢。", ja: "深く考えるほど、答えは遅くなります。", en: "Deeper thinking answers more slowly.")
    }
    static func thinkingLevel(_ level: String) -> String {
        switch level {
        case "off": text("关闭", ja: "オフ", en: "Off")
        case "minimal": text("最低", ja: "最小", en: "Minimal")
        case "low": text("低", ja: "低", en: "Low")
        case "medium": text("标准", ja: "標準", en: "Standard")
        case "high": text("高", ja: "高", en: "High")
        case "xhigh": text("很高", ja: "非常に高", en: "Very high")
        case "max": text("最高", ja: "最大", en: "Maximum")
        default: level
        }
    }
    static func modelName(_ model: ChatModel) -> String {
        model.automatic == true ? text("自动", ja: "自動", en: "Auto") : model.name
    }
    static func modelDetail(_ model: ChatModel) -> String? {
        if model.automatic == true {
            return text("额度用完时自动换来源", ja: "枠が尽きたら別の提供元へ切り替え", en: "Switches source when a quota runs out")
        }
        guard let price = model.price else { return nil }
        func dollars(_ value: Double) -> String {
            value == 0 ? "0" : value >= 10 ? String(format: "%.0f", value) : value >= 1 ? String(format: "%.2f", value) : String(format: "%.2g", value)
        }
        return text(
            "输入 $\(dollars(price.input)) · 输出 $\(dollars(price.output)) / 百万 token",
            ja: "入力 $\(dollars(price.input)) · 出力 $\(dollars(price.output)) / 100 万トークン",
            en: "Input $\(dollars(price.input)) · output $\(dollars(price.output)) per million tokens"
        )
    }
    static func priceTier(_ tier: ChatModel.PriceTier) -> String {
        switch tier {
        case .low: text("便宜", ja: "安い", en: "Cheap")
        case .mid: text("适中", ja: "中程度", en: "Mid")
        case .high: text("较贵", ja: "高め", en: "Pricey")
        }
    }
    static var aboutTitle: String { text("关于", ja: "このアプリについて", en: "About") }
    static var aboutVersion: String { text("版本", ja: "バージョン", en: "Version") }
    static var aboutServer: String { text("服务器", ja: "サーバー", en: "Server") }
    static var aboutLicenses: String { text("开源许可", ja: "オープンソースライセンス", en: "Open source licenses") }
    static var aboutNotConnected: String { text("没有连着", ja: "未接続", en: "Not connected") }
    static var developerMode: String { text("开发者模式", ja: "開発者モード", en: "Developer mode") }
    static var developer: String { text("开发者", ja: "開発者", en: "Developer") }
    static var talkTiming: String { text("说话计时", ja: "会話の計時", en: "Talk timing") }
    static var talkTimingRecent: String { text("最近 20 轮", ja: "直近 20 回", en: "Last 20 turns") }
    static var talkTimingTurns: String { text("每一轮", ja: "各回", en: "Each turn") }
    static var talkTimingTextGap: String { text("说完 → 第一个字", ja: "話し終わり → 最初の文字", en: "Done speaking → first word") }
    static var talkTimingSoundGap: String { text("第一个字 → 第一声", ja: "最初の文字 → 最初の声", en: "First word → first sound") }
    static var talkTimingDefinition: String {
        text(
            "一半：这些轮里一半在这个时间以内；九成：九成在这个时间以内。没出声的轮不算第二行。",
            ja: "半分：これらの回の半分がこの時間以内。9 割：9 割がこの時間以内。声が出なかった回は 2 行目に数えません。",
            en: "Half: half of these turns took this long or less. 90%: nine in ten did. Turns with no sound don't count toward the second row."
        )
    }
    static func talkTimingSpread(half: String, ninety: String) -> String {
        text("一半 \(half) · 九成 \(ninety)", ja: "半分 \(half) · 9 割 \(ninety)", en: "Half \(half) · 90% \(ninety)")
    }
    static func talkTimingTooFew(_ count: Int) -> String { text("轮数太少（\(count) 轮）", ja: "回数が少なすぎます（\(count) 回）", en: "Too few turns (\(count))") }
    static func seconds(_ value: String) -> String { text("\(value) 秒", ja: "\(value) 秒", en: "\(value) s") }
    static var talkTimingSilent: String { text("没出声", ja: "声なし", en: "No sound") }
    static var talkTimingSaid: String { text("说完", ja: "話し終わり", en: "Done speaking") }
    static var talkTimingFirstText: String { text("第一个字到手机", ja: "最初の文字が届いた", en: "First word reached the phone") }
    static var talkTimingFirstSound: String { text("第一声", ja: "最初の声", en: "First sound") }
    static var talkTimingEmitted: String { text("服务器发出第一个字", ja: "サーバーが最初の文字を送った", en: "Server sent the first word") }
    static var talkTimingEmpty: String { text("还没有说话记录", ja: "まだ会話の記録はありません", en: "No talk records yet") }
    static var talkTimingFailed: String { text("没读到计时", ja: "計時を読み込めませんでした", en: "Couldn't load timing") }
    static var tryAgain: String { text("再试一次", ja: "もう一度", en: "Try again") }
    static var allowancesTitle: String { text("同意过的事", ja: "承認したこと", en: "What you've allowed") }
    static func allowancesSummary(_ count: Int) -> String {
        if count == 0 { return text("还没有“不用再问”的事", ja: "「もう聞かない」ことはまだありません", en: "Nothing Himawari skips asking yet") }
        return text("\(count) 条“不用再问”", ja: "\(count) 件「もう聞かない」", en: "\(count) Himawari won't ask again")
    }
    static func vaultSummary(_ count: HerVaultCount) -> String? {
        guard case let .items(items) = count else { return nil }
        if items == 0 { return text("还没存东西", ja: "まだ何も入っていません", en: "Nothing stored yet") }
        return text("\(items) 项", ja: "\(items) 件", en: items == 1 ? "1 item" : "\(items) items")
    }
    static var allowancesEmpty: String {
        text(
            "在同意卡片上选“几天内”或“以后都行”的，会列在这里。",
            ja: "承認カードで「数日間」や「今後ずっと」を選んだものが、ここに並びます。",
            en: "Anything you allow for a few days or always on an approval card shows up here."
        )
    }
    static var allowanceDaysTitle: String { text("“几天内都行”是几天", ja: "「数日間」は何日", en: "How many days \"a few days\" lasts") }
    static func allowanceDaysValue(_ days: Int) -> String { text("\(days) 天", ja: "\(days)日", en: days == 1 ? "1 day" : "\(days) days") }
    static var allowanceDaysDone: String { text("好", ja: "OK", en: "OK") }
    static var allowanceDaysFailed: String { text("没改成，再试一次", ja: "変更できませんでした。もう一度試してください", en: "Couldn't change it. Try again") }
    static var revoke: String { text("撤销", ja: "取り消す", en: "Revoke") }
    static var revokeFailed: String { text("没撤掉，再试一次", ja: "取り消せませんでした。もう一度試してください", en: "Couldn't revoke. Try again") }
    static var allowancesFoot: String {
        text(
            "Himawari 读过网页、邮件之后，这些都不算数，照样先问你。花钱每次都问，不会出现在这里。",
            ja: "ウェブページやメールを読んだあとは、これらは無効になり、いつも通りあなたに確認します。お金を使うことは毎回確認するので、ここには出てきません。",
            en: "After Himawari reads a web page or email, none of these count and Himawari asks you first. Spending is asked every time and never shows up here."
        )
    }
    static func allowanceScope(_ allowance: OwnerAllowance) -> String {
        let created = Timestamp.parse(allowance.createdAt)
        let chose = created.map(pairedDay) ?? ""
        switch allowance.allowFor {
        case "always":
            return text("以后都行 · \(chose)你点的", ja: "今後ずっと · \(chose)に選択", en: "Always · you chose on \(chose)")
        case "days":
            guard let created, let expires = allowance.expiresAt.flatMap(Timestamp.parse) else { break }
            let days = Int((expires.timeIntervalSince(created) / 86_400).rounded())
            let until = pairedDay(expires)
            return text("\(days) 天内都行 · 到 \(until)", ja: "\(days)日間 · \(until)まで", en: "\(days) days · until \(until)")
        case "this_task":
            if let title = allowance.threadTitle {
                return text("这件事里都行 · \(title)", ja: "この件の間 · \(title)", en: "This task · \(title)")
            }
            return text("这件事里都行 · \(chose)你点的", ja: "この件の間 · \(chose)に選択", en: "This task · you chose on \(chose)")
        default:
            break
        }
        return text("\(chose)你点的", ja: "\(chose)に選択", en: "You chose on \(chose)")
    }

    static func approvalsWaiting(_ count: Int) -> String {
        text("等你同意 · \(count) 件", ja: "あなたの同意待ち · \(count) 件", en: "Waiting for you · \(count)")
    }
    static func phoneLine(_ name: String, _ presence: String) -> String { "\(name) · \(presence)" }
    static func pairedSince(_ date: Date) -> String {
        text("\(pairedDay(date))配对", ja: "\(pairedDay(date))にペアリング", en: "Paired \(pairedDay(date))")
    }
    static var disconnectThisIPhone: String { text("断开这台 iPhone", ja: "この iPhone の接続を解除", en: "Disconnect this iPhone") }
    static var quietWhen: String { text("勿扰时段", ja: "おやすみ時間", en: "Quiet hours") }
    static var quietAtNight: String { text("定时勿扰", ja: "時間指定で鳴らさない", en: "Scheduled quiet hours") }
    static var quietOff: String { text("关闭定时勿扰", ja: "時間指定をオフ", en: "Quiet hours off") }
    static var quietFrom: String { text("开始", ja: "開始", en: "From") }
    static var quietTo: String { text("结束", ja: "終了", en: "Until") }
    static func quietNote(end: String) -> String {
        text(
            "这段时间里 Himawari 的消息不响，到 \(end) 再响。要你同意的事照样响，不然那件事会一直卡着。",
            ja: "この間は Himawari からの通知を鳴らさず、\(end) に鳴らします。あなたの同意が要ることは鳴ります。止まったままになるからです。",
            en: "During this time Himawari's messages stay silent until \(end). Things that need your OK still ring, or they would stay stuck."
        )
    }
    static var quietSayIt: String {
        text(
            "在主对话里说“晚上 11 点以后别推”也一样，会改到这里。别的什么时候推，由 Himawari 看事情定。",
            ja: "会話で「夜 11 時以降は通知しないで」と言っても同じで、ここに反映されます。それ以外にいつ通知するかは、Himawari が内容を見て決めます。",
            en: "Saying \"don't notify me after 11 pm\" in the chat does the same and shows up here. When else to notify, Himawari decides from what's going on."
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
    static var deletePerception: String { text("删掉感知记录", ja: "感知の記録を削除", en: "Delete perception records") }
    static var letHerSense: String { text("让 Himawari 感知", ja: "Himawari に感じ取らせる", en: "Let Himawari Sense") }
    static func sensesOn(_ count: Int) -> String { text("\(count) 项开着", ja: "\(count) 項目オン", en: "\(count) on") }
    static var pauseMemory: String { text("暂停记忆", ja: "記憶を一時停止", en: "Pause memory") }
    static var resumeMemory: String { text("恢复记忆", ja: "記憶を再開", en: "Resume memory") }
    static var pauseMemoryDetail: String {
        text("Himawari 照常回答，但不记新的", ja: "返事はいつもどおり。新しいことは覚えません", en: "Himawari still answers, but won't remember anything new")
    }
    static var listenAlways: String { text("一直听着", ja: "ずっと聞く", en: "Keep listening") }
    static var listenAlwaysDetail: String {
        text("开着时 Himawari 听周围的话，叫名字就应。锁屏和灵动岛一直有标记", ja: "オンの間、Himawari は周りの声を聞き、名前を呼ぶと応えます。ロック画面と Dynamic Island に常に表示されます", en: "While on, Himawari listens around you and answers when you say its name. It always shows on the Lock Screen and Dynamic Island")
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
            "删掉后 Himawari 认不出哪句是你说的，要用时再录一次",
            ja: "削除すると、どれがあなたの声か分からなくなります。必要なときにまた登録してください",
            en: "Himawari won't be able to tell which words are yours until you record it again"
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
    static var previousVersions: String { text("以前的版本", ja: "以前の版", en: "Earlier versions") }
    static var useThisVersion: String { text("用这版", ja: "この版にする", en: "Use this") }
    static var confirmRestoreVersion: String { text("把这条记忆改回以前的版本", ja: "この記憶を以前の版に戻す", en: "Change this memory back to an earlier version") }
    static var trashTitle: String { text("回收站", ja: "ごみ箱", en: "Trash") }
    static func trashRow(_ count: Int) -> String { text("回收站 · \(count) 条", ja: "ごみ箱 · \(count) 件", en: "Trash · \(count)") }
    static var recover: String { text("恢复", ja: "戻す", en: "Restore") }
    static var confirmRecover: String { text("恢复这条记忆", ja: "この記憶を戻す", en: "Restore this memory") }
    static func trashedLine(_ trashed: Date, daysLeft: Int) -> String {
        text(
            "\(pairedDay(trashed))不要的 · 还剩 \(daysLeft) 天",
            ja: "\(pairedDay(trashed))に削除 · 残り\(daysLeft)日",
            en: "Removed \(pairedDay(trashed)) · \(daysLeft) \(daysLeft == 1 ? "day" : "days") left"
        )
    }
    static var trashFoot: String {
        let days = ClientCapabilities.memoryTrashDays
        return text("\(days) 天后自动删掉。", ja: "\(days)日後に自動で消えます。", en: "Deleted for good after \(days) days.")
    }
    static var deleteNote: String {
        let days = ClientCapabilities.memoryTrashDays
        return text("不要的进回收站，\(days) 天内能恢复", ja: "削除したものはごみ箱に入り、\(days)日以内なら戻せます", en: "Deleted memories go to Trash and can be restored for \(days) days")
    }
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
    static var gmailTitle: String { "Gmail" }
    static var gmailConnectTitle: String { text("连接 Gmail，让 Himawari 帮你盯收件箱", ja: "Gmail を接続して受信箱を見てもらう", en: "Connect Gmail so Himawari keeps an eye on your inbox") }
    static var gmailConnectBody: String {
        text(
            "只读。每 15 分钟看一次新邮件，要你处理的事和快到期的事由 Himawari 告诉你；只有要紧又快到期的才推送。",
            ja: "読み取りのみ。15 分ごとに新着メールを読み、対応が必要なことや期限が近いことを伝えます。急ぎで期限が近いものだけ通知します。",
            en: "Read-only. Every 15 minutes Himawari reads new mail and tells you what needs you and what is due soon. Only urgent things due soon are pushed."
        )
    }
    static var gmailNotConnected: String { text("没连接", ja: "未接続", en: "Not connected") }
    static var gmailConnect: String { text("连接 Gmail", ja: "Gmail を接続", en: "Connect Gmail") }
    static var gmailReconnect: String { text("重新连接", ja: "再接続", en: "Reconnect") }
    static func gmailConnectedOn(_ date: Date) -> String {
        text("连接于 \(pairedDay(date))", ja: "\(pairedDay(date))に接続", en: "Connected \(pairedDay(date))")
    }
    static var gmailLastRead: String { text("上次看邮件", ja: "最後にメールを確認", en: "Last checked mail") }
    static var gmailExpired: String { text("Google 授权失效，Gmail 读不了", ja: "Google の許可が切れ、Gmail を読めません", en: "Google access expired, so Gmail can’t be read") }
    static func gmailUnreadSince(_ date: Date) -> String {
        let shown = date.formatted(.dateTime.month().day().hour().minute().locale(locale))
        return text("从 \(shown) 起没看邮件", ja: "\(shown) 以降メールを確認していません", en: "No mail checked since \(shown)")
    }
    static var gmailDailyLimit: String { text("今天到了每日费用上限，0:00 恢复", ja: "今日の費用上限に達しました。0:00 に再開します", en: "Today’s cost limit is reached; checks resume at 0:00") }
    static var gmailWatch: String { text("盯着新邮件", ja: "新着メールを見張る", en: "Watch new mail") }
    static var gmailWatchOn: String { text("Himawari 定时看新邮件，要紧的会提醒你", ja: "Himawari が定期的に新着メールを確認し、大事なものを知らせます", en: "Himawari checks new mail on a schedule and tells you about what matters") }
    static var gmailWatchOff: String { text("Himawari 现在不自己看新邮件", ja: "Himawari は今、自分では新着メールを確認しません", en: "Himawari isn’t checking new mail on its own right now") }
    static var gmailWatchStart: String { text("开始盯着新邮件", ja: "新着メールの見張りを始める", en: "Start watching new mail") }
    static var gmailWatchStop: String { text("不再盯着新邮件", ja: "新着メールの見張りをやめる", en: "Stop watching new mail") }
    static var connectionsTitle: String { text("连接", ja: "接続", en: "Connections") }
    static var connectionConnected: String { text("已连接", ja: "接続済み", en: "Connected") }
    static var connectionExpired: String { text("授权失效，要重新连接", ja: "許可が切れました。再接続してください", en: "Access expired. Reconnect") }
    static func connectionConnect(_ title: String) -> String { text("连接 \(title)", ja: "\(title) を接続", en: "Connect \(title)") }
    static func connectionAbout(_ title: String) -> String {
        text(
            "连接后 Himawari 能用 \(title) 查东西；建、改、删之类会改东西的操作，每次都先问你。",
            ja: "接続すると Himawari が \(title) で調べものができます。作成・変更・削除など内容を変える操作は毎回先に確認します。",
            en: "Once connected, Himawari can look things up in \(title). Anything that creates, changes or deletes something asks you first, every time."
        )
    }
    static func connectionDisconnect(_ title: String) -> String { text("断开 \(title)", ja: "\(title) の接続を解除", en: "Disconnect \(title)") }
    static var connectionDisconnectDetail: String {
        text("Himawari 不再能用这个应用，存在服务器上的登录也一并删掉。", ja: "Himawari はこのアプリを使えなくなり、サーバーに保存したログインも削除します。", en: "Himawari can no longer use this app, and the sign-in kept on the server is deleted.")
    }
    static func connectionDenied(_ title: String) -> String { text("你没有同意，\(title) 没连上", ja: "許可されなかったため、\(title) に接続していません", en: "Access wasn’t granted, so \(title) isn’t connected") }
    static func connectionFailed(_ title: String) -> String { text("\(title) 没连上，再试一次", ja: "\(title) に接続できませんでした。もう一度お試しください", en: "\(title) didn’t connect. Try again") }
    static var connectionsThisDevice: String { text("这台 iPhone", ja: "この iPhone", en: "This iPhone") }
    static var connectionHealth: String { text("健康", ja: "ヘルスケア", en: "Health") }
    static var connectionHealthInSenses: String { text("点这里打开感知设置，在里面开关", ja: "ここから感知の設定を開いてオン・オフします", en: "Opens sensing settings, where you turn it on or off") }
    static var connectionAdd: String { text("添加应用", ja: "アプリを追加", en: "Add App") }
    static var connectionAddAddress: String { text("MCP 服务器网址", ja: "MCP サーバーの URL", en: "MCP server URL") }
    static var connectionAddName: String { text("名字（可不填）", ja: "名前（任意）", en: "Name (optional)") }
    static var connectionAddNameNote: String { text("不填就用对方服务器自报的名字", ja: "空欄ならサーバーが名乗る名前を使います", en: "Leave blank to use the name the server gives") }
    static var connectionAddAdvanced: String { text("高级", ja: "詳細", en: "Advanced") }
    static var connectionAddClientId: String { text("客户端编号", ja: "クライアント ID", en: "Client ID") }
    static var connectionAddClientSecret: String { text("客户端密钥", ja: "クライアントシークレット", en: "Client secret") }
    static var connectionAddAdvancedNote: String {
        text(
            "一般不用填。只有对方不能自动给 Himawari 发编号时，才去对方后台建一个应用，把它给的编号填在这里。",
            ja: "通常は空欄のままで大丈夫です。相手が Himawari に ID を自動で発行できないときだけ、相手の管理画面でアプリを作り、その ID をここに入れます。",
            en: "Usually left blank. Only if the service can’t issue Himawari an ID on its own, create an app in its developer settings and enter the ID it gives here."
        )
    }
    static var connectionAddWarning: String {
        text(
            "这是没经过审核的服务，只添加你信任的。Himawari 用它的每个工具之前都会先问你。",
            ja: "審査されていないサービスです。信頼できるものだけを追加してください。Himawari はそのツールを使う前に毎回確認します。",
            en: "This service hasn’t been reviewed. Only add ones you trust. Himawari asks you before using any of its tools."
        )
    }
    static var connectionAddReason: String { text("添加应用", ja: "アプリを追加", en: "Add an app") }
    static var connectionAddInvalid: String {
        text("网址要以 https:// 开头，不能写账号密码，也不能是内网地址", ja: "URL は https:// で始まり、アカウント情報や社内ネットワークのアドレスを含めないでください", en: "The URL must start with https:// and can’t include a sign-in or a private network address")
    }
    static var connectionAddUnreachable: String { text("连不上这个网址，或者它不是 MCP 服务器", ja: "この URL に接続できないか、MCP サーバーではありません", en: "Couldn’t reach this URL, or it isn’t an MCP server") }
    static var connectionAddFailed: String { text("没加上，再试一次", ja: "追加できませんでした。もう一度お試しください", en: "Couldn’t add it. Try again") }
    static func connectionAddedAbout(_ title: String) -> String {
        text(
            "\(title) 是你自己添加的。连接后 Himawari 每次用它的工具之前都先问你，包括只是查东西的。",
            ja: "\(title) はあなたが追加したアプリです。接続後、Himawari はそのツールを使う前に、調べるだけのものも含めて毎回確認します。",
            en: "You added \(title) yourself. Once connected, Himawari asks you before using any of its tools, even ones that only look things up."
        )
    }
    static func connectionRemove(_ title: String) -> String { text("移除 \(title)", ja: "\(title) を削除", en: "Remove \(title)") }
    static var connectionRemoveDetail: String {
        text("这个应用从列表里去掉，存在服务器上的登录和客户端编号也一并删掉。", ja: "このアプリを一覧から外し、サーバーに保存したログインとクライアント ID も削除します。", en: "The app leaves the list, and the sign-in and client ID kept on the server are deleted.")
    }
    static func connectionClientRequired(_ title: String) -> String { text("\(title) 要你提供客户端编号", ja: "\(title) にはクライアント ID が必要です", en: "\(title) needs a client ID") }
    static func connectionClientRequiredDetail(_ title: String, _ redirectUri: String) -> String {
        text(
            "\(title) 不能自动给 Himawari 发编号。去它的开发者后台建一个应用，回调地址填 \(redirectUri)；然后移除这个应用，重新添加时在“高级”里填上编号。",
            ja: "\(title) は Himawari に ID を自動で発行できません。開発者向け設定でアプリを作り、コールバック URL に \(redirectUri) を入れてください。そのあとこのアプリを削除し、追加し直すときに「詳細」に ID を入れます。",
            en: "\(title) can’t issue Himawari an ID on its own. Create an app in its developer settings with the callback URL \(redirectUri), then remove this app and add it again with the ID under Advanced."
        )
    }
    static var connectionsNoneConnected: String { text("还没连接应用", ja: "まだアプリを接続していません", en: "No apps connected yet") }
    static var gmailDisconnect: String { text("断开 Gmail", ja: "Gmail の接続を解除", en: "Disconnect Gmail") }
    static var gmailDisconnectDetail: String {
        text("Himawari 不再看你的邮件，Google 那边的授权也一并收回。", ja: "メールを読まなくなり、Google 側の許可も取り消します。", en: "Himawari stops reading your mail and the Google access is revoked.")
    }
    static var gmailDenied: String { text("你在 Google 没有同意，Gmail 没连上", ja: "Google で許可されなかったため、接続していません", en: "Google access wasn’t granted, so Gmail isn’t connected") }
    static var gmailFailed: String { text("Gmail 没连上，再试一次", ja: "Gmail に接続できませんでした。もう一度お試しください", en: "Gmail didn’t connect. Try again") }
}
