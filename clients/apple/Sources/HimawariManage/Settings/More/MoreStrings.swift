import Foundation
import HimawariCore

extension M {
    static var moreYouGroup: String { text("你的偏好", ja: "あなたの設定", en: "Your preferences") }
    static var moreConnectedGroup: String { text("接入与记录", ja: "接続と記録", en: "Connections and records") }

    static var personalizationTitle: String { text("个性化", ja: "パーソナライズ", en: "Personalization") }
    static var personalName: String { text("怎么称呼你", ja: "お呼びする名前", en: "What should I call you?") }
    static var personalNameHint: String { text("不填就不用称呼", ja: "空欄なら名前では呼びません", en: "Leave empty to use no name") }
    static var localeTitle: String { text("界面语言", ja: "表示言語", en: "Interface language") }
    static var localeNote: String {
        text(
            "存在服务器上，网页用它。手机界面跟着 iPhone 的系统语言。",
            ja: "サーバーに保存され、ウェブで使われます。iPhone の表示は本体の言語に従います。",
            en: "Saved on the server for the web. This phone follows the iPhone's system language."
        )
    }
    static func localeName(_ locale: OwnerLocale) -> String {
        switch locale {
        case .zhCN: "简体中文"
        case .en: "English"
        case .ja: "日本語"
        }
    }
    static var confirmPersonalization: String { text("修改个性化设置", ja: "パーソナライズを変更", en: "Change personalization") }
    static var preferencesSaved: String { text("已保存", ja: "保存しました", en: "Saved") }
    static var preferencesStale: String {
        text("刚在别处改过，已更新，请再看一眼再存", ja: "ほかで変更されたため更新しました。確認してからもう一度保存してください", en: "Changed elsewhere just now and refreshed. Check and save again")
    }

    static var mcpTitle: String { text("接入的 agent", ja: "接続した agent", en: "Connected agents") }
    static var mcpIntro: String {
        text(
            "给别的 agent（例如 Claude 桌面版）各一个接入，各有读取上限，暂停、撤销立刻生效。新建和换密钥要在网页上做，专用地址只在那里显示一次。",
            ja: "ほかの agent（Claude デスクトップ版など）ごとの接続です。読み取りの上限があり、一時停止と取り消しはすぐに効きます。作成と鍵の作り直しはウェブで行い、専用アドレスはそこで一度だけ表示されます。",
            en: "One connection per other agent (for example Claude desktop), each with its own read ceiling. Pausing or revoking takes effect at once. Creating one or rotating its key is done on the web, where the address is shown once."
        )
    }
    static var mcpEmpty: String { text("还没有接入", ja: "まだ接続はありません", en: "No connections yet") }
    static var mcpRevokedGroup: String { text("已撤销", ja: "取り消し済み", en: "Revoked") }
    static func mcpStatus(_ status: String) -> String {
        switch status {
        case McpConnections.active: text("使用中", ja: "使用中", en: "Active")
        case McpConnections.paused: text("已暂停", ja: "一時停止中", en: "Paused")
        case McpConnections.revoked: mcpRevokedGroup
        default: status
        }
    }
    static func mcpLastSeen(_ iso: String?) -> String {
        guard let iso, let date = DeviceActionTime.parse(iso) else { return text("还没用过", ja: "まだ使われていません", en: "Not used yet") }
        return text("最近一次 \(relative(date))", ja: "最後の利用 \(relative(date))", en: "Last used \(relative(date))")
    }
    static func mcpReported(_ client: String) -> String {
        text("对方自称：\(client)", ja: "自己申告：\(client)", en: "Reports itself as: \(client)")
    }
    static var mcpCeiling: String { text("最多能读到", ja: "読める範囲の上限", en: "Can read up to") }
    static func mcpCeilingName(_ ceiling: String) -> String {
        switch ceiling {
        case "public": text("公开", ja: "公開", en: "Public")
        case "private": text("私人", ja: "個人", en: "Private")
        case "sensitive": text("敏感", ja: "機微", en: "Sensitive")
        default: ceiling
        }
    }
    static var mcpRename: String { text("改名", ja: "名前を変更", en: "Rename") }
    static var mcpName: String { text("名称", ja: "名前", en: "Name") }
    static var mcpPause: String { text("暂停", ja: "一時停止", en: "Pause") }
    static var mcpResume: String { text("恢复", ja: "再開", en: "Resume") }
    static var mcpRevoke: String { text("撤销", ja: "取り消す", en: "Revoke") }
    static var mcpRevokeAsk: String {
        text("撤销后这个接入再也不能用，不能恢复。", ja: "取り消すとこの接続は二度と使えず、元に戻せません。", en: "The connection stops working for good and cannot be restored.")
    }
    static func mcpWindow(_ window: McpWindow) -> String {
        text(
            "下面的数字是最近 \(window.days) 天（\(window.fromDay) 至 \(window.toDay)）",
            ja: "以下の数字は直近 \(window.days) 日間（\(window.fromDay)〜\(window.toDay)）です",
            en: "Numbers below cover the last \(window.days) days (\(window.fromDay) to \(window.toDay))"
        )
    }
    static func mcpReads(_ count: Int) -> String { text("读取 \(count) 次", ja: "読み取り \(count) 回", en: "Reads: \(count)") }
    static func mcpDelivered(_ count: Int) -> String { text("交出内容 \(count) 次", ja: "内容あり \(count) 回", en: "Delivered: \(count)") }
    static func mcpEmptyReads(_ count: Int) -> String { text("空手而归 \(count) 次", ja: "空振り \(count) 回", en: "Empty: \(count)") }
    static func mcpFailed(_ count: Int) -> String { text("失败 \(count) 次", ja: "失敗 \(count) 回", en: "Failed: \(count)") }
    static var mcpDefinitionsTitle: String { text("每个数字怎么算", ja: "各数字の数え方", en: "How each number is counted") }
    static var mcpDefinitions: String {
        text(
            "读取：调用读工具的次数。交出内容：返回了至少一条内容的读取。空手而归：没找到任何内容的读取。失败：认出了接入、但出错或参数不合格的调用。",
            ja: "読み取り：読み取りツールの呼び出し回数。内容あり：1 件以上返した読み取り。空振り：何も見つからなかった読み取り。失敗：接続は特定できたがエラーか引数不正だった呼び出し。",
            en: "Reads: calls to read tools. Delivered: reads that returned at least one item. Empty: reads that found nothing. Failed: calls from a recognised connection that errored or had invalid arguments."
        )
    }
    static func confirmMcp(_ name: String) -> String {
        text("修改接入“\(name)”", ja: "接続「\(name)」を変更", en: "Change connection \(name)")
    }

    static var searchTitle: String { text("联网搜索", ja: "ウェブ検索", en: "Web search") }
    static var searchAllow: String { text("允许联网搜索", ja: "ウェブ検索を許可", en: "Allow web search") }
    static var searchOffNote: String {
        text("现在关着，需要联网搜索时会先在对话里问你。", ja: "いまはオフなので、検索が必要なときは会話で先に確認します。", en: "It's off now, so Himawari asks in the chat before it searches.")
    }
    static var searchProvidersChanged: String {
        text(
            "搜索服务换了地址，你还没同意过，所以先关上了；看过下面的地址后打开就行。",
            ja: "検索サービスの送信先が、まだ許可していないアドレスに変わったため、いったんオフにしました。下のアドレスを確認してからオンにしてください。",
            en: "The search service moved to an address you haven't approved, so it's off for now. Check the addresses below and turn it back on."
        )
    }
    static var searchNotConfigured: String {
        text("服务器还没配置搜索服务，现在打不开。", ja: "サーバーに検索サービスが設定されていないため、オンにできません。", en: "The server has no search service set up, so it can't be turned on.")
    }
    static var searchSentTitle: String { text("搜索时会发出什么", ja: "検索で送られるもの", en: "What a search sends") }
    static var searchSent: String {
        text(
            "你的问题会被改写成搜索词，发到下面这些网址；打开网页时，网页地址也会发过去。它们拿不到你的文件、附件和命令；看起来像密码或密钥的搜索词会先遮盖再发出。",
            ja: "質問は検索語に書き換えられて下のアドレスに送られます。Web ページを開くときは、その URL も送られます。ファイル、添付、コマンドは渡りません。パスワードや鍵のように見える検索語は、マスキングしてから送られます。",
            en: "Your question is turned into search terms and sent to the addresses below. When a page is opened, its address is sent too. They don't get your files, attachments or commands, and terms that look like passwords or keys are redacted first."
        )
    }
    static var confirmSearchOn: String { text("允许联网搜索", ja: "ウェブ検索を許可", en: "Allow web search") }
    static var confirmSearchOff: String { text("撤销联网搜索授权", ja: "ウェブ検索の許可を取り消す", en: "Revoke web search permission") }

    static var sensitiveTitle: String { text("敏感信息拦截记录", ja: "機密情報のブロック記録", en: "Blocked sensitive information") }
    static var sensitiveHint: String {
        text("只记类别和出处，不保存原文", ja: "種類と出どころだけを記録し、原文は保存しません", en: "Only the kind and where it came from are recorded, never the text itself")
    }
    static var sensitiveNone: String { text("还没有拦下过敏感信息", ja: "ブロックした機密情報はまだありません", en: "Nothing has been blocked yet") }
    static func sensitiveFilter(_ filter: SensitiveFilter, count: Int) -> String {
        switch filter {
        case .all: text("全部 \(count)", ja: "すべて \(count)", en: "All \(count)")
        case .masked: text("发给模型前遮住 \(count)", ja: "送信前にマスキング \(count)", en: "Redacted before sending \(count)")
        case .withheld: text("整段没发给模型 \(count)", ja: "丸ごと送らず \(count)", en: "Not sent at all \(count)")
        case .notSaved: text("没记进记忆 \(count)", ja: "記憶に残さず \(count)", en: "Not saved to memory \(count)")
        }
    }
    static func sensitiveCategory(_ category: String) -> String {
        switch category {
        case "machine-secret": text("密钥", ja: "鍵", en: "Secret key")
        case "password": text("密码", ja: "パスワード", en: "Password")
        case "verification-code": text("验证码", ja: "認証コード", en: "Verification code")
        case "bank-card": text("银行卡号", ja: "カード番号", en: "Card number")
        case "identity-number": text("证件号", ja: "証明書番号", en: "ID number")
        default: category
        }
    }
    static func sensitivePart(_ part: String) -> String {
        switch part {
        case "owner_message": text("你的话", ja: "あなたの言葉", en: "Your message")
        case "assistant_message": text("模型的回答", ja: "モデルの回答", en: "Model reply")
        case "tool_call": text("工具调用", ja: "ツール呼び出し", en: "Tool call")
        case "tool_result": text("工具结果", ja: "ツールの結果", en: "Tool result")
        case "embedding_input": text("记忆检索", ja: "記憶の検索", en: "Memory search")
        case "file": text("你上传的文件", ja: "アップロードしたファイル", en: "A file you uploaded")
        case "command_output": text("命令输出", ja: "コマンドの出力", en: "Command output")
        case "web_page": text("打开的网页", ja: "開いたウェブページ", en: "A page that was opened")
        case "mail": text("一封收件箱里的邮件", ja: "受信箱のメール", en: "An email in your inbox")
        case "memory_candidate", "memory_source": text("自动整理记忆", ja: "記憶の自動整理", en: "Automatic memory tidy-up")
        default: text("系统提示", ja: "システムプロンプト", en: "System prompt")
        }
    }
    static var today: String { text("今天", ja: "今日", en: "Today") }
    static var yesterday: String { text("昨天", ja: "昨日", en: "Yesterday") }
    static var sensitiveBackground: String { text("后台", ja: "バックグラウンド", en: "Background") }
    static var sensitiveThread: String { text("一个对话", ja: "ある会話", en: "A conversation") }
    static func sensitiveWhat(_ item: SensitiveItem, time: String) -> String {
        switch item.outcome {
        case SensitiveFilter.notSaved.rawValue:
            text("\(time) 这条记忆没有保存，需要的话可以自己补记", ja: "\(time) この記憶は保存されませんでした。必要なら自分で追加できます", en: "\(time) This memory wasn't saved. Add it yourself if you need it")
        case SensitiveFilter.withheld.rawValue:
            text("\(time) 整段没有发给模型", ja: "\(time) 丸ごとモデルに送っていません", en: "\(time) Not sent to the model at all")
        default:
            item.seenCount <= 1
                ? text("\(time) 遮住 1 次", ja: "\(time) 1 回マスキング", en: "\(time) Redacted once")
                : text("\(time) 第一次遮住，之后 \(item.seenCount - 1) 次发送都已遮住", ja: "\(time) 初回にマスキング、その後 \(item.seenCount - 1) 回の送信も対象", en: "\(time) First redacted, then \(item.seenCount - 1) more sends redacted")
        }
    }
    static var sensitiveMore: String { text("显示更早的记录", ja: "以前の記録を表示", en: "Show older records") }
    static var sensitiveFooter: String {
        text("记录不会自动删除；删掉对话时一起删除", ja: "記録は自動では消えません。会話を削除すると一緒に消えます", en: "Records aren't deleted automatically; deleting a conversation removes its records")
    }
    static var sensitiveClear: String { text("清除记录", ja: "記録を消去", en: "Clear records") }
    static var sensitiveClearAsk: String {
        text("清除全部拦截记录？对话本身不受影响。", ja: "ブロック記録をすべて消去しますか？会話自体には影響しません。", en: "Clear all blocked-information records? Conversations aren't affected.")
    }
    static var sensitiveCleared: String { text("已清除", ja: "消去しました", en: "Cleared") }

    static var pushKindsTitle: String { text("通知种类", ja: "通知の種類", en: "Notification types") }
    static func pushKind(_ kind: String) -> String {
        switch kind {
        case "reminder": text("记忆提醒", ja: "記憶のリマインダー", en: "Memory reminders")
        case "approval": text("等你审批", ja: "承認待ち", en: "Waiting for approval")
        case "run": text("任务结束", ja: "タスク終了", en: "Task finished")
        default: kind
        }
    }
    static func pushKindHint(_ kind: String) -> String? {
        switch kind {
        case "reminder": text("到点时提醒你记下的事", ja: "覚えておいたことの時間になったとき", en: "When something you asked to remember is due")
        case "approval": text("任务停下来等你批准时", ja: "タスクがあなたの承認を待って止まったとき", en: "When a task stops for your go-ahead")
        case "run": text("一轮任务完成或失败时", ja: "タスクが完了または失敗したとき", en: "When a task completes or fails")
        default: nil
        }
    }
    static func pushDevices(_ count: Int) -> String {
        text("\(count) 台设备在接收推送", ja: "\(count) 台のデバイスが通知を受信中", en: count == 1 ? "1 device receives notifications" : "\(count) devices receive notifications")
    }
    static var pushNoDevices: String {
        text("还没有设备开启推送，在设备上开启后才会收到", ja: "通知をオンにしたデバイスはまだありません", en: "No device has notifications on yet")
    }
    static var pushUnavailable: String {
        text("服务器还没配置推送", ja: "サーバーに通知が設定されていません", en: "The server has no notifications set up")
    }
    static func confirmPushKind(_ kind: String) -> String {
        text("改“\(pushKind(kind))”通知", ja: "「\(pushKind(kind))」の通知を変更", en: "Change \(pushKind(kind)) notifications")
    }

    static var museTitle: String { text("Muse 对照", ja: "Muse との比較", en: "Muse comparison") }
    static var museNote: String {
        text(
            "这些是 Muse 定时推给 Himawari 的提醒。请对每条判断两件事：时机对不对，内容对不对。",
            ja: "Muse が定期的に Himawari へ送るリマインダーです。それぞれについて、タイミングと内容が適切だったかを判断してください。",
            en: "Reminders Muse pushes to Himawari on a schedule. For each one, judge two things: was the timing right, and was the content right."
        )
    }
    static var museNever: String { text("还没有收到 Muse 的数据", ja: "Muse からのデータはまだありません", en: "No data from Muse yet") }
    static func museChannel(_ channel: MuseChannel, time: String?) -> String {
        let at = time ?? "—"
        switch channel.state {
        case "ok": return text("通道正常，最近一批 \(at)", ja: "連携は正常です。最新のバッチ \(at)", en: "Channel is working. Last batch at \(at)")
        case "stale": return text("通道可能中断了，最近一批 \(at)", ja: "連携が止まっている可能性があります。最新のバッチ \(at)", en: "The channel may be down. Last batch at \(at)")
        case "down": return text("通道已中断，最近一批 \(at)", ja: "連携が止まっています。最新のバッチ \(at)", en: "The channel is down. Last batch at \(at)")
        case "paused": return text("已暂停接收，Muse 发来的新数据会被拒收", ja: "受信を一時停止中です。Muse からの新しいデータは拒否されます", en: "Receiving is paused. New data from Muse is refused")
        default: return museNever
        }
    }
    static func museGaps(_ count: Int) -> String {
        text("批次序号跳过 \(count) 次，可能漏发过一批", ja: "バッチ番号が \(count) 回飛びました。届いていない分があるかもしれません", en: "Batch numbers skipped \(count) times. A batch may have been missed")
    }
    static func museReceived(_ count: Int) -> String { text("近 7 天收到 \(count) 条", ja: "直近 7 日で \(count) 件受信", en: "\(count) received in the last 7 days") }
    static func musePending(_ count: Int) -> String { text("\(count) 条待评价", ja: "評価待ち \(count) 件", en: "\(count) waiting for your rating") }
    static func museSuppressed(_ count: Int) -> String {
        text("另有 \(count) 条被 Muse 压下，没有送到你手上", ja: "ほかに \(count) 件は Muse が見送り、あなたには届いていません", en: "\(count) more were held back by Muse and never reached you")
    }
    static func museDelay(_ delay: MuseDelay) -> String {
        let parts = MuseOverview.delayParts(minutes: delay.medianMinutes)
        let value = parts.value.rounded() == parts.value ? "\(Int(parts.value))" : String(format: "%.1f", parts.value)
        let duration = parts.unit == .minutes
            ? text("\(value) 分钟", ja: "\(value) 分", en: "\(value) min")
            : text("\(value) 小时", ja: "\(value) 時間", en: "\(value) h")
        return text(
            "事件到提醒的中位延迟约 \(duration)（\(delay.samples) 条）",
            ja: "出来事からリマインダーまでの遅延の中央値は約 \(duration)（\(delay.samples) 件）",
            en: "Median delay from event to reminder: about \(duration) (\(delay.samples) reminders)"
        )
    }
    static var museEmpty: String { text("最近 30 天没有可以评价的条目", ja: "直近 30 日に評価できる項目はありません", en: "Nothing to rate in the last 30 days") }
    static func museKind(_ kind: String) -> String {
        switch kind {
        case "proactive": text("主动消息", ja: "自発メッセージ", en: "Proactive")
        case "scheduled": text("定时任务", ja: "定期タスク", en: "Scheduled")
        default: kind
        }
    }
    static var museWithheld: String { text("一条敏感内容", ja: "機微な内容の 1 件", en: "A sensitive item") }
    static var museNoText: String { text("没有正文", ja: "本文なし", en: "No text") }
    static var museTiming: String { text("时机", ja: "タイミング", en: "Timing") }
    static var museContent: String { text("内容", ja: "内容", en: "Content") }
    static var museRight: String { text("对", ja: "適切", en: "Right") }
    static var museWrong: String { text("不对", ja: "不適切", en: "Wrong") }
    static var museUndo: String { text("撤销评价", ja: "評価を取り消す", en: "Undo rating") }
    static var museIntake: String { text("接收 Muse 数据", ja: "Muse のデータを受信", en: "Receive Muse data") }
    static var museIntakeHint: String {
        text("暂停后，Muse 发来的新数据会被拒收，已收到的保留。", ja: "一時停止中は Muse からの新しいデータを拒否します。受信済みのデータは残ります。", en: "While paused, new data from Muse is refused. What was already received stays.")
    }
    static var museClear: String { text("清除 Muse 数据", ja: "Muse のデータを消去", en: "Clear Muse data") }
    static var museClearAsk: String {
        text(
            "确定清除所有自动收到的 Muse 条目和你对它们的评价吗？这不能撤销。",
            ja: "自動で受信した Muse の項目とそれらへの評価をすべて削除しますか？元に戻せません。",
            en: "Delete every Muse item received automatically and your ratings of them? This can't be undone."
        )
    }
    static var museCleared: String { text("已清除", ja: "消去しました", en: "Cleared") }
    static var confirmMuseRate: String { text("给这条 Muse 对照打分", ja: "この Muse 比較を採点", en: "Rate this Muse comparison") }
    static var confirmMuseIntake: String { text("改变 Muse 数据的接收", ja: "Muse データの受信を変更", en: "Change receiving Muse data") }
    static var confirmMuseClear: String { text("清除 Muse 数据", ja: "Muse のデータを消去", en: "Clear Muse data") }
    static var confirmSensitiveClear: String { text("清除敏感信息拦截记录", ja: "機密情報のブロック記録を消去", en: "Clear blocked-information records") }
    static var clear: String { text("清除", ja: "消去", en: "Clear") }
}
