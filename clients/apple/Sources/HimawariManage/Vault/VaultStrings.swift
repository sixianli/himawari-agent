import Foundation
import HimawariCore

extension M {
    static var vaultTitle: String { text("保险箱", ja: "金庫", en: "Vault") }
    static var vaultIntro: String {
        text(
            "Himawari 只知道每一项的名字和能用在哪个网站，看不到值。每次用都要你批准。",
            ja: "Himawari が知っているのは各項目の名前と使えるサイトだけで、値は見えません。使うたびにあなたの承認が必要です。",
            en: "Himawari only knows each item's name and the site it works on, never the value. Every use needs your approval."
        )
    }
    static var vaultEmpty: String { text("还没有存东西", ja: "まだ何も入っていません", en: "Nothing stored yet") }
    static var vaultAdd: String { text("加一项", ja: "追加", en: "Add an item") }
    static var vaultBackgroundTag: String { text("后台也能用", ja: "バックグラウンドでも使える", en: "Works in background") }
    static var vaultSecurityTitle: String { text("丢手机、换钥匙", ja: "紛失・鍵の交換", en: "Lost phone, new key") }
    static var vaultSecuritySubtitle: String {
        text("注销丢了的手机，或者换一把总钥匙", ja: "なくした iPhone を解除するか、マスターキーを交換", en: "Remove a lost phone or switch to a new master key")
    }
    static func vaultUsedLine(_ site: String, _ when: String?) -> String {
        guard let when else { return site }
        return text("\(site) · \(when)用过", ja: "\(site) · \(when)に使用", en: "\(site) · used \(when)")
    }
    static var vaultImport: String { text("从苹果“密码”导入", ja: "Apple の「パスワード」から読み込む", en: "Import from Apple Passwords") }
    static var vaultImportSubtitle: String {
        text("一次选好要给 Himawari 的那些，不用一项项抄", ja: "渡す項目をまとめて選べます", en: "Pick everything you want Himawari to use at once")
    }
    static var vaultManual: String { text("手动加", ja: "手入力で追加", en: "Add by hand") }
    static var vaultManualSubtitle: String {
        text("API key 这类“密码”App 里没有的", ja: "API key など「パスワード」App にないもの", en: "Things like API keys that Passwords doesn't hold")
    }
    static var vaultAddLater: String {
        text(
            "不先加也行：Himawari 用到一个没存过的网站时会来问你，你当场从“密码”里选。",
            ja: "先に追加しなくても大丈夫。まだないサイトを使うとき、Himawari が聞きに来ます。",
            en: "You can also skip this: when Himawari needs a site you haven't stored, Himawari will ask you then."
        )
    }
    static var vaultEncryptedHere: String {
        text(
            "值在这台 iPhone 上加密后才发给服务器，存好以后任何地方都不再显示，只能换成新的。",
            ja: "値はこの iPhone で暗号化してからサーバーに送ります。保存後はどこにも表示されず、新しい値に替えることしかできません。",
            en: "Values are encrypted on this iPhone before they reach the server. Once stored they're never shown again; you can only replace them."
        )
    }
    static var vaultKindLogin: String { text("登录", ja: "ログイン", en: "Login") }
    static var vaultKindKey: String { text("API key", ja: "API key", en: "API key") }
    static var vaultName: String { text("名字", ja: "名前", en: "Name") }
    static var vaultSite: String { text("网站", ja: "サイト", en: "Site") }
    static var vaultSitePlaceholder: String { "https://" }
    static func vaultSiteSaved(_ origin: String) -> String { text("存成 \(origin)", ja: "\(origin) として保存", en: "Saved as \(origin)") }
    static var vaultSiteInvalid: String { text("只收 https 开头的网站", ja: "https で始まるサイトだけです", en: "Only https sites") }
    static var vaultUsername: String { text("用户名", ja: "ユーザー名", en: "Username") }
    static var vaultPassword: String { text("密码", ja: "パスワード", en: "Password") }
    static var vaultKey: String { text("key", ja: "key", en: "Key") }
    static var vaultTOTP: String { text("两步验证密钥（可选）", ja: "2 段階認証の鍵（任意）", en: "Two-step key (optional)") }
    static var vaultTOTPShort: String { text("两步验证密钥", ja: "2 段階認証の鍵", en: "Two-step key") }
    static var vaultSave: String { text("存好", ja: "保存", en: "Save") }
    static var vaultReplace: String { text("换一个", ja: "替える", en: "Replace") }
    static var vaultReplaceWith: String { text("换成这个", ja: "これに替える", en: "Use this instead") }
    static var vaultStoredHidden: String { text("已存 · 不再显示", ja: "保存済み・表示しません", en: "Stored · never shown") }
    static var vaultSiteRow: String { text("能用在哪个网站", ja: "使えるサイト", en: "Works on") }
    static var vaultBackgroundNote: String {
        text(
            "打开后，定时任务用这一项不用问你；服务器被黑时这一项会泄露",
            ja: "オンにすると定期タスクは確認なしで使います。サーバーが侵入されるとこの項目は漏れます",
            en: "When on, scheduled tasks use it without asking. If the server is broken into, this item leaks"
        )
    }
    static var vaultUsageTitle: String { text("用过的记录", ja: "使用履歴", en: "Usage") }
    static var vaultUsageEmpty: String { text("还没用过", ja: "まだ使っていません", en: "Not used yet") }
    static func vaultUsageOutcome(_ outcome: VaultUsageOutcome) -> String {
        switch outcome {
        case .approved: text("你批准了", ja: "承認しました", en: "You approved")
        case .denied: text("你没批准", ja: "承認しませんでした", en: "You declined")
        case .expired: text("没点就作废了", ja: "期限切れ", en: "Expired")
        case .filled: text("填好了", ja: "入力しました", en: "Filled in")
        case .failed: text("没成", ja: "失敗", en: "Failed")
        }
    }
    static var vaultDelete: String { text("删掉这一项", ja: "この項目を削除", en: "Delete this item") }
    static var vaultApproveTitle: String { text("批准一次使用", ja: "1 回の使用を承認", en: "Approve one use") }
    static func vaultOnlyFor(_ origin: String) -> String { text("只填进 \(origin)", ja: "\(origin) にだけ入力", en: "Only for \(origin)") }
    static var vaultMatches: String { text("名字和网站和你存的一致", ja: "名前とサイトは保存した内容と一致", en: "Name and site match what you stored") }
    static var vaultPurposeLabel: String { text("Himawari 要做什么（这是 Himawari 说的，只作参考）", ja: "何をするか（Himawari の説明・参考のみ）", en: "What Himawari's doing (Himawari words, for reference)") }
    static var vaultApproveFooter: String {
        text(
            "只管这次办事 · 2 分钟内不点就作废。登录以后要付款、转账，Himawari 会再单独问你。",
            ja: "今回の用事だけ・2 分以内に押さないと無効。ログイン後の支払いや送金は別に確認します。",
            en: "Only for this task · expires if you don't tap within 2 minutes. Payments or transfers after login are asked separately."
        )
    }
    static var vaultDeny: String { text("不批准", ja: "承認しない", en: "Decline") }
    static var vaultApprove: String { text("批准", ja: "承認", en: "Approve") }
    static func vaultApproveReason(_ name: String) -> String { text("批准使用“\(name)”", ja: "「\(name)」の使用を承認", en: "Approve using \(name)") }
    static var vaultRequestGone: String { text("这次请求已经处理过或过期了", ja: "このリクエストは処理済みか期限切れです", en: "This request was already handled or expired") }
    static var vaultRequestMismatch: String {
        text("清单对不上，已拒绝。可能有人改了服务器上的清单。", ja: "一覧が一致しないため拒否しました。サーバー上の一覧が改ざんされた可能性があります。", en: "The list didn't match, so it was refused. Someone may have changed the list on the server.")
    }
    static var vaultManifestInvalid: String {
        text("服务器上的清单和你签过名的不一致，先不显示。", ja: "サーバーの一覧が署名と一致しないため表示しません。", en: "The server's list doesn't match what you signed, so it isn't shown.")
    }
    static var vaultKeyMissing: String {
        text("这台 iPhone 上还没有总钥匙。打开 iCloud 钥匙串，等它从你的其他设备同步过来。", ja: "この iPhone にマスターキーがまだありません。iCloud キーチェーンをオンにして同期を待ってください。", en: "This iPhone doesn't have the master key yet. Turn on iCloud Keychain and wait for it to sync from your other devices.")
    }
    static var vaultPhonesGroup: String { text("能批准的手机", ja: "承認できる iPhone", en: "Phones that can approve") }
    static var vaultThisPhone: String { text("这台 · 正在用", ja: "この iPhone・使用中", en: "This one · in use") }
    static var vaultRevoke: String { text("注销", ja: "解除", en: "Remove") }
    static func vaultRevokeReason(_ name: String) -> String { text("注销 \(name)", ja: "\(name) を解除", en: "Remove \(name)") }
    static var vaultRevokeNote: String {
        text("手机丢了，在任何一台苹果设备上注销它：它以后的批准服务器都不认。", ja: "なくしたら、どの Apple デバイスからでも解除できます。以後その承認は受け付けません。", en: "If a phone is lost, remove it from any of your Apple devices. The server won't accept its approvals after that.")
    }
    static var vaultRotate: String { text("换一把总钥匙", ja: "マスターキーを交換", en: "Switch to a new master key") }
    static var vaultRotateSubtitle: String {
        text("怀疑钥匙泄露时用；每一项在这台手机上重新加密一遍", ja: "鍵の漏えいが疑われるとき。全項目をこの iPhone で暗号化し直します", en: "Use if you suspect a leak. Every item is re-encrypted on this phone")
    }
    static var vaultRotateDone: String { text("换好了", ja: "交換しました", en: "Done") }
    static var vaultKeyLocation: String { text("总钥匙存在你的 iCloud 钥匙串里，换手机会自动带过去。", ja: "マスターキーは iCloud キーチェーンにあり、機種変更でも引き継がれます。", en: "The master key lives in your iCloud Keychain and moves with you to a new phone.") }
    static var vaultSaveFailed: String { text("没存上，再试一次", ja: "保存できませんでした。もう一度お試しください", en: "Couldn't save. Try again") }
    static var vaultConflict: String { text("别的设备刚改过，已刷新，再试一次", ja: "別のデバイスが変更しました。更新したのでもう一度", en: "Another device just changed it. Refreshed; try again") }
    static var vaultScan: String { text("扫码", ja: "スキャン", en: "Scan") }
    static var vaultScanAim: String { text("对准网站给的两步验证二维码", ja: "サイトの 2 段階認証 QR コードに向けてください", en: "Point at the site's two-step QR code") }
    static var vaultTOTPInvalid: String {
        text("两步验证密钥只能是字母 A–Z 和数字 2–7", ja: "2 段階認証の鍵は A–Z と 2–7 だけです", en: "A two-step key only has letters A–Z and digits 2–7")
    }
}
