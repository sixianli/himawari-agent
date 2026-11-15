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
    static var settings: String { text("设置", ja: "設定", en: "Settings") }
    static var runsOnYourServer: String {
        text("跑在你自己的服务器上", ja: "あなた自身のサーバーで動いています", en: "Running on your own server")
    }
    static var himawariSelf: String { text("Himawari 自己", ja: "Himawari 自身", en: "Himawari itself") }
    static var proposalsTitle: String { text("待采纳的改进", ja: "採用待ちの改善", en: "Improvements to adopt") }
    static var proposalsSubtitle: String {
        text("它想改自己的做法，你说了算", ja: "自分のやり方を変えたい。決めるのはあなた", en: "It wants to change how it works. You decide")
    }
    static var proposalsNone: String { text("没有", ja: "なし", en: "None") }
    static var noProposals: String { text("没有待采纳的改进", ja: "採用待ちの改善はありません", en: "No improvements waiting") }
    static var proposalAdopt: String { text("采纳", ja: "採用", en: "Adopt") }
    static var proposalDecline: String { text("不要", ja: "見送る", en: "No thanks") }
    static var proposalWhy: String { text("为什么这么想", ja: "そう考えた理由", en: "Why it thinks so") }
    static var proposalHideWhy: String { text("收起", ja: "閉じる", en: "Hide") }
    static var proposalAdopted: String { text("已采纳", ja: "採用しました", en: "Adopted") }
    static var proposalChanged: String { text("这条刚改了，请重新看一眼", ja: "この項目が変わりました。もう一度ご確認ください", en: "This one just changed. Please look again") }
    static var proposalGone: String { text("这条已经处理过或过期了", ja: "この項目は処理済みか期限切れです", en: "This one was already handled or expired") }
    static func proposalsFootnote(limit: Int, days: Int) -> String {
        text(
            "最多同时留 \(limit) 条，\(days) 天没处理的会收走",
            ja: "同時に最大 \(limit) 件。\(days) 日たつと片付けられます",
            en: "Up to \(limit) at a time. Untouched ones go away after \(days) days"
        )
    }
    static func proposalFigure(_ figure: ProposalFigure) -> String { "\(figure.name) \(figure.value)" }
    static var capabilities: String { text("它会的本事", ja: "できること", en: "What it can do") }
    static var waitingForYou: String { text("等你看", ja: "確認待ち", en: "Waiting for you") }
    static var inUse: String { text("在用", ja: "使用中", en: "In use") }
    static func disabledAt(_ iso: String, now: Date = Date()) -> String? {
        guard let date = Timestamp.parse(iso) else { return nil }
        let time = date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).locale(Locale(identifier: "en_GB")))
        let day = Calendar.current.isDate(date, inSameDayAs: now) ? text("今天", ja: "今日", en: "Today") : pairedDay(date)
        return text("\(day) \(time) 停用", ja: "\(day) \(time) に停止", en: "\(day) \(time) turned off")
    }

    static func cancelledJobs(_ count: Int) -> String? {
        guard count > 0 else { return nil }
        return text("取消了 \(count) 个定时任务，不会自动恢复", ja: "定期タスク \(count) 件を取り消しました。自動では戻りません", en: "\(count) scheduled tasks were cancelled and won't resume on their own")
    }

    static var reactivateFailed: String { text("没能重新启用", ja: "再び有効にできませんでした", en: "Couldn't turn it back on") }

    static func confirmReactivateCapability(_ name: String) -> String {
        text("重新启用“\(name)”", ja: "「\(name)」を再び有効にする", en: "Turn \(name) back on")
    }

    static var disabledCapabilities: String { text("停用了", ja: "停止中", en: "Turned off") }
    static func capabilityExpansions(_ items: [String]) -> String? {
        guard !items.isEmpty else { return nil }
        let joined = items.joined(separator: "、")
        return text("多了：\(joined)，要你同意", ja: "追加：\(joined)。確認が必要です", en: "Adds: \(joined). Needs your approval")
    }
    static func confirmDisableCapability(_ name: String) -> String {
        text("停用“\(name)”", ja: "「\(name)」を停止", en: "Turn off \"\(name)\"")
    }
    static var noCapabilities: String { text("还没有装上的本事", ja: "まだ何も入っていません", en: "Nothing installed yet") }
    static var confirmAdopt: String { text("采纳这条改进", ja: "この改善を採用", en: "Adopt this improvement") }
    static var confirmReject: String { text("不要这条改进", ja: "この改善を見送る", en: "Turn down this improvement") }
    static var rule: String { text("规则", ja: "ルール", en: "Rule") }
    static var reconfirmRule: String { text("重新确认", ja: "もう一度確認", en: "Confirm again") }
    static var ruleEnforced: String { text("在执行", ja: "実行中", en: "In effect") }
    static var confirmUndoRule: String { text("停用这条规则", ja: "このルールを止める", en: "Pause this rule") }
    static var confirmReconfirmRule: String { text("重新确认这条规则", ja: "このルールをもう一度確認", en: "Confirm this rule again") }

    static func ruleState(_ rule: RuleSummary) -> String {
        if rule.status == "needs_review" { return ruleNeedsReview }
        return rule.enforced ? ruleEnforced : rulePaused
    }

    static func updatedOn(_ date: String?) -> String {
        guard let date else { return text("更新过", ja: "更新済み", en: "Updated") }
        return text("\(date) 更新", ja: "\(date) に更新", en: "Updated \(date)")
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

    static func serverState(_ reach: ServerReach) -> String {
        switch reach {
        case .connected: text("连着", ja: "つながっています", en: "Connected")
        case .notReady: text("服务器没准备好", ja: "サーバーの準備ができていません", en: "Server not ready")
        case .unreachable: text("连不上", ja: "つながりません", en: "Can't connect")
        }
    }

    static func serverLine(_ reach: ServerReach?) -> String {
        guard let reach else { return runsOnYourServer }
        return "\(runsOnYourServer) · \(serverState(reach))"
    }

    static var myDevices: String { text("我的设备", ja: "自分のデバイス", en: "My devices") }
    static var addDevice: String { text("添加设备", ja: "デバイスを追加", en: "Add a device") }
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
    static var confirmAddDevice: String { text("添加设备", ja: "デバイスを追加", en: "Add a device") }
    static var scanWithNewDevice: String { text("用新设备上的 Himawari 扫它", ja: "新しいデバイスの Himawari で読み取って", en: "Scan this with Himawari on the new device") }

    static func expiresIn(_ seconds: Int) -> String {
        let minutes = seconds / 60
        let rest = seconds % 60
        return text("\(minutes) 分 \(rest) 秒后失效", ja: "あと \(minutes) 分 \(rest) 秒で無効", en: "Expires in \(minutes)m \(rest)s")
    }

    static var sendPairingLink: String { text("Mac 不方便扫：发配对链接过去", ja: "Mac で読み取りにくいとき：リンクを送る", en: "Can't scan on a Mac? Send the pairing link") }
    static var codeExpired: String { text("这个码失效了", ja: "このコードは無効になりました", en: "This code has expired") }
    static func codeExpiredHint(minutes: Int?) -> String {
        guard let minutes else {
            return text("一个码只能用一次，过一会儿就失效。", ja: "コードは 1 回だけ使え、しばらくすると無効になります。", en: "A code works once and expires after a while.")
        }
        return text("一个码只管 \(minutes) 分钟，也只能用一次。", ja: "コードは \(minutes) 分間、1 回だけ使えます。", en: "A code lasts \(minutes) min and works once.")
    }
    static var makeAnother: String { text("再出一个", ja: "もう一度出す", en: "Make another") }
    static func wantsToPair(_ name: String) -> String { text("“\(name)”想配对", ja: "「\(name)」がペアリングしたい", en: "\u{201C}\(name)\u{201D} wants to pair") }
    static var sameNumberHint: String { text("那台设备上的数字一样，再点确认", ja: "あちらの数字と同じなら確認を押して", en: "If the other device shows the same number, tap Confirm") }
    static var notMine: String { text("不认识", ja: "知らない", en: "Not mine") }
    static var confirm: String { text("确认", ja: "確認", en: "Confirm") }
    static func confirmPair(_ name: String) -> String { text("和 \(name) 配对", ja: "\(name) とペアリング", en: "Pair with \(name)") }
    static func refusePair(_ name: String) -> String { text("拒绝 \(name)", ja: "\(name) を拒否", en: "Refuse \(name)") }

    static func pairingNumber(_ digits: String) -> String {
        "\(digits.prefix(3)) \(digits.suffix(3))"
    }

    private static var locale: Locale {
        Locale(identifier: ManageLanguage.current == .en ? "en_US" : ManageLanguage.current == .ja ? "ja_JP" : "zh_CN")
    }

    static var yourWords: String { text("你的原话", ja: "あなたの言葉", en: "Your words") }
    static var on: String { text("开", ja: "オン", en: "On") }
    static var off: String { text("关", ja: "オフ", en: "Off") }
    static var notificationsTitle: String { text("通知", ja: "通知", en: "Notifications") }
    static var deliveryGroup: String { text("什么时候送", ja: "いつ届けるか", en: "When to deliver") }
    static var thinkTitle: String { text("想一想的门槛", ja: "考える基準", en: "Thinking thresholds") }
    static var tuningDisabled: String { text("未开启", ja: "オフ", en: "Off") }
    static var tuningSave: String { text("保存", ja: "保存", en: "Save") }
    static var tuningRestore: String { text("恢复默认", ja: "初期値に戻す", en: "Restore default") }
    static var tuningSaveFailed: String { text("没能保存", ja: "保存できませんでした", en: "Couldn't save") }
    static func tuningDefault(_ value: String) -> String {
        text("默认 \(value)", ja: "初期値 \(value)", en: "Default \(value)")
    }
    static func confirmTuning(_ name: String) -> String {
        text("修改“\(name)”", ja: "「\(name)」を変更", en: "Change \(name)")
    }

    static var general: String { text("通用", ja: "一般", en: "General") }
    static var exportTitle: String { text("导出记忆和规则", ja: "記憶とルールを書き出す", en: "Export memories and rules") }
    static var confirmExport: String { text("导出记忆和规则", ja: "記憶とルールを書き出す", en: "Export your memories and rules") }
    static var exportPacking: String { text("正在打包", ja: "まとめています", en: "Packing") }
    static var exportLeaveAndReturn: String { text("可以先离开，回来再看", ja: "いったん離れても大丈夫。あとで見に来てください", en: "You can leave and come back") }
    static var stopExport: String { text("不导了", ja: "やめる", en: "Stop") }
    static var exportReady: String { text("打包好了", ja: "まとまりました", en: "Ready") }
    static func exportExpiry(_ expiresAt: String, now: Date = Date()) -> String? {
        guard let date = Timestamp.parse(expiresAt), date > now else { return nil }
        let days = Int((date.timeIntervalSince(now) / 86_400).rounded(.up))
        return text("\(days) 天后从服务器上删掉", ja: "\(days) 日後にサーバーから削除されます", en: "Deleted from the server in \(days) days")
    }

    static func exportContents(_ result: DataExportResult) -> String {
        let size = ByteCountFormatter.string(fromByteCount: Int64(result.sizeBytes), countStyle: .file)
        return text(
            "\(result.memories) 条记忆、\(result.rules) 条规则 · \(size)",
            ja: "記憶 \(result.memories) 件、ルール \(result.rules) 件 · \(size)",
            en: "\(result.memories) memories, \(result.rules) rules · \(size)"
        )
    }
    static func exportWithheld(_ count: Int) -> String {
        text("另有 \(count) 条敏感内容没导出", ja: "ほかに \(count) 件の機密内容は書き出していません", en: "\(count) sensitive items were left out")
    }
    static var saveToFiles: String { text("存到“文件”", ja: "「ファイル」に保存", en: "Save to Files") }
    static var sendElsewhere: String { text("发到别处", ja: "ほかへ送る", en: "Share") }
    static var exportExpired: String { text("过期了", ja: "期限が切れました", en: "Expired") }
    static var exportPackFailed: String { text("没能打包", ja: "まとめられませんでした", en: "Couldn't pack it") }
    static var exportDownloadFailed: String { text("没能下载", ja: "ダウンロードできませんでした", en: "Couldn't download it") }
    static var downloadAgain: String { text("再下载一次", ja: "もう一度ダウンロード", en: "Download again") }
    static var exportAgain: String { text("重新打包", ja: "もう一度まとめる", en: "Pack again") }
    static var loginBrowsers: String { text("登录着的浏览器", ja: "ログイン中のブラウザ", en: "Signed-in browsers") }
    static var noLoginBrowsers: String { text("没有登录着的浏览器", ja: "ログイン中のブラウザはありません", en: "No browsers signed in") }
    static var signOut: String { text("退出", ja: "ログアウト", en: "Sign out") }
    static func confirmSignOut(_ label: String) -> String {
        text("让“\(label)”退出登录", ja: "「\(label)」をログアウト", en: "Sign out \(label)")
    }
    static func loginSeen(_ device: LoginDevice) -> String {
        if device.current { return text("现在在用", ja: "いま使用中", en: "In use now") }
        guard let seen = Timestamp.parse(device.lastSeenAt) else { return "" }
        return relative(seen)
    }
    static var files: String { text("文件", ja: "ファイル", en: "Files") }
    static func fileOrigin(_ origin: FileOrigin) -> String {
        switch origin {
        case .generated: text("它存下的", ja: "Himawari が保存した", en: "Saved by Himawari")
        case .uploaded: text("你发给它的", ja: "あなたが送った", en: "Sent by you")
        }
    }
    static func noFiles(_ origin: FileOrigin) -> String {
        switch origin {
        case .generated: text("它还没存过文件", ja: "まだ保存したファイルはありません", en: "Nothing saved yet")
        case .uploaded: text("你还没发过文件", ja: "まだ送ったファイルはありません", en: "You haven't sent any files")
        }
    }
    static func fileLine(day: Date, thread: String?) -> String {
        let when = relative(day)
        guard let title = thread?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else { return when }
        return text("\(when) · 对话“\(title)”", ja: "\(when) · 会話「\(title)」", en: "\(when) · “\(title)”")
    }
    static var signOutOthers: String { text("退出其他全部", ja: "ほかをすべてログアウト", en: "Sign out all others") }
    static var confirmSignOutOthers: String { text("让其他浏览器全部退出登录", ja: "ほかのブラウザをすべてログアウト", en: "Sign out all other browsers") }
    static var loginStillChanging: String {
        text("有别的设备正在登录或退出，过一会儿再试", ja: "ほかのデバイスがログイン中かログアウト中です。少し待ってからもう一度", en: "Another device is signing in or out. Try again in a moment.")
    }
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
