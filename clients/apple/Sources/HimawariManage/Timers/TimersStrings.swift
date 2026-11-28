import Foundation
import HimawariCore

extension M {
    static var timersTitle: String { text("定时", ja: "タイマー", en: "Timers") }

    static func timersSummary(active: Int, paused: Int) -> String {
        guard active + paused > 0 else { return text("还没有定时", ja: "まだタイマーはありません", en: "No timers yet") }
        let running = text("\(active) 条在跑", ja: "\(active) 件動いています", en: "\(active) running")
        guard paused > 0 else { return running }
        return running + " · " + text("\(paused) 条暂停", ja: "\(paused) 件一時停止", en: "\(paused) paused")
    }

    static var timersLead: String {
        text("所有提醒、周期任务、跟进；点进去能暂停、能撤销", ja: "リマインダー、定期タスク、フォローアップのすべて。開くと一時停止や取り消しができます", en: "All reminders, recurring tasks and follow-ups. Open one to pause or cancel it")
    }

    static var timersFoot: String {
        text("在主对话里说“取消交房租的提醒”也行。", ja: "メインの会話で「家賃のリマインダーを取り消して」と言っても大丈夫です。", en: "You can also say “cancel the rent reminder” in the main chat.")
    }

    static var timersLoadFailed: String { text("没读到定时，下拉再试一次", ja: "タイマーを読み込めませんでした。引っ張って再試行", en: "Couldn't load timers. Pull to try again") }

    static func timerKind(_ kind: OwnerTimer.Kind) -> String {
        switch kind {
        case .reminder: text("提醒", ja: "リマインダー", en: "Reminders")
        case .recurring: text("周期任务", ja: "定期タスク", en: "Recurring tasks")
        case .followUp: text("跟进", ja: "フォローアップ", en: "Follow-ups")
        }
    }

    static var timerPaused: String { text("暂停了", ja: "一時停止中", en: "Paused") }
    static var timerPause: String { text("暂停", ja: "一時停止", en: "Pause") }
    static var timerResume: String { text("继续", ja: "再開", en: "Resume") }
    static var timerCancel: String { text("撤销", ja: "取り消す", en: "Cancel timer") }
    static var timerCancelWarning: String { text("撤销后不再到点，也不能恢复。", ja: "取り消すと二度と動かず、元に戻せません。", en: "Once cancelled it won't fire again, and it can't be restored.") }
    static var timerChangeFailed: String { text("没改成，再试一次", ja: "変更できませんでした。もう一度", en: "That didn't go through. Try again") }

    static func timerReason(_ action: OwnerTimer.Action, _ name: String) -> String {
        switch action {
        case .pause: text("暂停“\(name)”", ja: "「\(name)」を一時停止", en: "Pause “\(name)”")
        case .resume: text("继续“\(name)”", ja: "「\(name)」を再開", en: "Resume “\(name)”")
        case .cancel: text("撤销“\(name)”", ja: "「\(name)」を取り消す", en: "Cancel “\(name)”")
        }
    }

    static func timerWhen(_ when: TimerWhen) -> String {
        func clock(_ hour: Int, _ minute: Int) -> String { String(format: "%d:%02d", hour, minute) }
        switch when {
        case let .today(hour, minute):
            return text("今天 \(clock(hour, minute))", ja: "今日 \(clock(hour, minute))", en: "Today \(clock(hour, minute))")
        case let .tomorrow(hour, minute):
            return text("明天 \(clock(hour, minute))", ja: "明日 \(clock(hour, minute))", en: "Tomorrow \(clock(hour, minute))")
        case let .weekday(weekday, hour, minute):
            let index = (weekday - 1 + 7) % 7
            let zh = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][index]
            let ja = ["日曜", "月曜", "火曜", "水曜", "木曜", "金曜", "土曜"][index]
            let en = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][index]
            return text("\(zh) \(clock(hour, minute))", ja: "\(ja) \(clock(hour, minute))", en: "\(en) \(clock(hour, minute))")
        case let .day(month, day, hour, minute):
            return text("\(month) 月 \(day) 日 \(clock(hour, minute))", ja: "\(month)月\(day)日 \(clock(hour, minute))", en: "\(month)/\(day) \(clock(hour, minute))")
        }
    }

    static func timerBy(_ createdBy: OwnerTimer.CreatedBy) -> String {
        switch createdBy {
        case .owner: text("你说的", ja: "あなたが言った", en: "You asked")
        case .agreed: text("Himawari 提议、你同意的", ja: "Himawari の提案にあなたが同意", en: "Himawari suggested, you agreed")
        case .her: text("Himawari 想到的", ja: "Himawari が思いついた", en: "Himawari's idea")
        }
    }

    static func timerByOn(_ createdBy: OwnerTimer.CreatedBy, _ date: Date) -> String {
        let day = pairedDay(date)
        switch createdBy {
        case .owner: return text("你 \(day)说的", ja: "あなたが \(day) に言った", en: "You asked on \(day)")
        case .agreed: return timerBy(.agreed) + " · " + day
        case .her: return timerBy(.her) + " · " + day
        }
    }

    static func money(_ micros: Int) -> String {
        guard let dollars = MicroDollars.dollars(micros) else {
            return text("不到 0.01 美元", ja: "0.01 ドル未満", en: "under $0.01")
        }
        return text("\(dollars) 美元", ja: "\(dollars) ドル", en: "$\(dollars)")
    }

    static func timerRan(_ count: Int, _ micros: Int) -> String {
        text("跑过 \(count) 次，花了 \(money(micros))", ja: "\(count) 回実行、\(money(micros)) 使用", en: "Ran \(count) times, spent \(money(micros))")
    }

    static func timerRanDetail(_ count: Int, _ micros: Int) -> String {
        guard count > 0 else { return text("还没跑过", ja: "まだ実行していません", en: "Hasn't run yet") }
        return text("\(count) 次，花了 \(money(micros))", ja: "\(count) 回、\(money(micros)) 使用", en: "\(count) times, spent \(money(micros))")
    }

    static var timerWhenLabel: String { text("什么时候", ja: "いつ", en: "When") }
    static var timerTaskLabel: String { text("要做的事", ja: "やること", en: "What to do") }
    static var timerByLabel: String { text("谁定的", ja: "誰が決めたか", en: "Set by") }
    static var timerRanLabel: String { text("跑过", ja: "実行", en: "Runs") }
    static var timerBudgetLabel: String { text("每次最多花", ja: "1 回の上限", en: "Limit per run") }
    static var timerLastLabel: String { text("上次", ja: "前回", en: "Last time") }

    static func timerNext(_ when: String) -> String { text("下次 \(when)", ja: "次回 \(when)", en: "Next \(when)") }

    static func timerMoreWords(_ count: Int) -> String { text("还有 \(count) 句", ja: "あと \(count) 件", en: "\(count) more") }

    static func timerDetailLead(canPause: Bool) -> String {
        canPause
            ? text("暂停可以再继续；撤销就不再到点", ja: "一時停止は再開できます。取り消すと二度と動きません", en: "Paused timers can resume; cancelled ones never fire again")
            : text("撤销就不再到点", ja: "取り消すと二度と動きません", en: "Once cancelled it never fires again")
    }
}
