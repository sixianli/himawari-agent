import Foundation
import HimawariCore

extension M {
    static var proactiveTitle: String { text("系统主动提醒", ja: "自発的なリマインダー", en: "Proactive reminders") }
    static var proactivePaused: String {
        text(
            "系统主动提醒已关：不看邮件、不记录、不推送。",
            ja: "自発的なリマインダーはオフです。メールの確認・記録・通知をしていません。",
            en: "Proactive reminders are off: no mail is read, logged or pushed."
        )
    }
    static var confirmProactiveOn: String { text("打开系统主动提醒", ja: "自発的なリマインダーをオンにする", en: "Turn proactive reminders on") }
    static var confirmProactiveOff: String { text("关闭系统主动提醒", ja: "自発的なリマインダーをオフにする", en: "Turn proactive reminders off") }
    static var confirmProactiveRate: String { text("给这条打分", ja: "これを採点する", en: "Rate this") }
    static var confirmProactiveRespond: String { text("处理这条提醒", ja: "このリマインダーを処理する", en: "Handle this reminder") }
    static var confirmProactiveRestore: String { text("恢复这一类的推送", ja: "この種類の通知を元に戻す", en: "Restore pushes for this kind") }
    static func confirmProactiveSource(_ name: String) -> String {
        text("改“\(name)”的设置", ja: "「\(name)」の設定を変える", en: "Change settings for \(name)")
    }

    static func sourceConnection(_ overview: ProactiveOverview) -> String {
        switch overview.connection.status {
        case "connected":
            return text("已连接 · \(overview.connection.account ?? "—")", ja: "接続済み · \(overview.connection.account ?? "—")", en: "Connected · \(overview.connection.account ?? "—")")
        case "needs_reconnect":
            return text("授权失效，要在网页上重新连接", ja: "許可が切れました。ウェブで再接続してください", en: "Access expired; reconnect on the web")
        default:
            return text("未连接", ja: "未接続", en: "Not connected")
        }
    }

    static var proactiveDailyLimit: String {
        text(
            "今天的邮件检查到了每日费用上限：模型先停，规则照常把银行、学校等来信放进来；0:00 自动恢复，对话不受影响。",
            ja: "本日のメール確認が 1 日の費用上限に達しました。モデルは止めていますが、銀行・学校などのメールはルールで引き続き表示します。0:00 に自動再開し、チャットへの影響はありません。",
            en: "Mail checks hit today’s spending limit. The model is paused, but rules still bring in mail from banks, schools and the like. It resumes at 0:00, and chat is unaffected."
        )
    }

    static func proactiveBackoff(_ backoff: ProactiveBackoff) -> String {
        if backoff.stage == 1 {
            return text(
                "来自 \(backoff.domain) 的提醒，你连续 \(backoff.ignoredCount) 次没点开，已降频：这一类最多每天推送 1 条。",
                ja: "\(backoff.domain) からのリマインダーを \(backoff.ignoredCount) 回続けて開かなかったため、この種類の通知は 1 日 1 件までに減らしました。",
                en: "You skipped \(backoff.ignoredCount) reminders in a row from \(backoff.domain), so pushes for them are reduced to at most one a day."
            )
        }
        return text(
            "来自 \(backoff.domain) 的提醒，降频后你又连续 \(backoff.ignoredCount) 次没点开，已暂停推送。",
            ja: "通知を減らした後も \(backoff.domain) からのリマインダーを \(backoff.ignoredCount) 回続けて開かなかったため、この種類の通知を一時停止しました。",
            en: "You skipped \(backoff.ignoredCount) more reminders from \(backoff.domain) after pushes were reduced, so pushes for them are paused."
        )
    }

    static var proactiveRestore: String { text("恢复推送", ja: "通知を元に戻す", en: "Restore pushes") }

    static var proactiveStats: String { text("最近 30 天", ja: "直近 30 日", en: "Last 30 days") }
    static var metricSpoke: String { text("主动提醒总次数", ja: "自発的なリマインダーの総数", en: "Total proactive reminders") }
    static var metricHits: String { text("恰当的提醒", ja: "適切なリマインダー", en: "Appropriate reminders") }
    static var metricMisfires: String { text("多余的提醒", ja: "余計なリマインダー", en: "Unneeded reminders") }
    static var metricMissed: String { text("漏提醒（你查过的邮件里）", ja: "見逃し（確認したメールの中）", en: "Reminders it missed (in emails you checked)") }
    static func metricReviewed(_ count: Int) -> String {
        text("已审 \(count) 封", ja: "\(count) 通確認", en: "\(count) reviewed")
    }
    static var metricsDefinition: String {
        text(
            "你打了“做对了”或 24 小时内点开的算恰当；打了“不该做”、划掉或 24 小时没点开的算多余；漏提醒只算你查过的邮件。",
            ja: "「正しかった」と採点したもの、24 時間以内に開いたものは適切。「やるべきではなかった」と採点したもの、閉じたもの、24 時間開かなかったものは余計。見逃しは確認したメールだけ数えます。",
            en: "Appropriate means you rated it “Right call” or opened it within 24 hours. Unneeded means you rated it “Shouldn’t have done it”, dismissed it, or didn’t open it within 24 hours. Missed counts only emails you checked."
        )
    }

    static var proactiveToHandle: String { text("待处理", ja: "対応待ち", en: "To handle") }
    static var proactiveDone: String { text("完成", ja: "完了", en: "Done") }
    static var proactiveMute: String { text("不再提醒", ja: "通知しない", en: "Don’t remind") }
    static var proactiveLog: String { text("提醒检查记录", ja: "リマインダー確認の記録", en: "Reminder check record") }
    static var proactiveLogEmpty: String {
        text("还没有检查记录", ja: "まだ確認の記録はありません", en: "No check records yet")
    }
    static var proactiveSources: String { text("检查的来源", ja: "確認する情報源", en: "Sources it checks") }
    static var proactiveReport: String { text("校准周报", ja: "較正レポート", en: "Calibration report") }
    static var proactiveQuiet: String { text("不推送时段", ja: "通知しない時間帯", en: "Quiet hours") }
    static var proactiveQuietNone: String { text("没设", ja: "なし", en: "None") }
    static var proactiveQuietFootnote: String {
        text("要改时段，到网页上改", ja: "時間帯の変更はウェブで", en: "Change quiet hours on the web")
    }

    static var everyDay: String { text("每天", ja: "毎日", en: "Every day") }

    static func quietSummary(_ period: ProactiveQuietPeriod, calendar: Calendar = .current) -> String {
        let days = period.coversEveryDay
            ? everyDay
            : period.sortedDays.map { calendar.shortWeekdaySymbols[$0 % 7] }.joined(separator: " ")
        return "\(period.start)–\(period.end) · \(days)"
    }

    static func proactiveDue(_ date: Date) -> String {
        let stamp = date.formatted(date: .abbreviated, time: .shortened)
        return text("\(stamp) 截止", ja: "\(stamp) 締切", en: "Due \(stamp)")
    }

    static func proactivePriority(_ priority: String) -> String? {
        switch priority {
        case "high": text("高优先级", ja: "優先度：高", en: "High priority")
        case "medium": text("中优先级", ja: "優先度：中", en: "Medium priority")
        case "low": text("低优先级", ja: "優先度：低", en: "Low priority")
        default: nil
        }
    }

    static func proactiveRating(_ rating: ProactiveRating) -> String {
        switch rating {
        case .useful: text("做对了", ja: "正しかった", en: "Right call")
        case .unneeded: text("不该做", ja: "やるべきではなかった", en: "Shouldn’t have done it")
        case .missed: text("该做没做", ja: "やるべきだった", en: "Should have done it")
        }
    }

    static func proactiveVerdict(_ verdict: String) -> String {
        switch verdict {
        case "pushed": text("推送", ja: "通知", en: "Pushed")
        case "silent": text("没提醒", ja: "通知せず", en: "Stayed quiet")
        case "deferred": text("顺延", ja: "保留", en: "Held")
        case "failed": text("失败", ja: "失敗", en: "Failed")
        case "capped": text("到上限", ja: "上限到達", en: "Hit limit")
        case "capped_daily": text("到上限（日）", ja: "上限到達（1 日）", en: "Hit daily limit")
        default: text("要你处理", ja: "対応が必要", en: "Needs you")
        }
    }

    static func proactiveLine(_ line: ProactiveDecisionLine) -> String {
        switch line {
        case .needsOwner:
            return text("Google 授权失效，Gmail 读不了；暂停检查，等你重新连接", ja: "Google の許可が切れ、Gmail を読めません。再接続まで確認を止めています", en: "Google access expired, so Gmail can’t be read. Checks are paused until you reconnect")
        case .pushed(let count):
            return text("推送了 \(count) 件要你处理的事", ja: "対応が必要なこと \(count) 件を通知", en: "Pushed \(count) \(count == 1 ? "thing that needs" : "things that need") you")
        case .deferred:
            return text("判断要说，但在不推送时段里，时段结束时合成一条推送", ja: "知らせるべきと判断。ただし通知しない時間帯中のため、終わったときに 1 件にまとめて通知します", en: "Worth telling you, but inside quiet hours; it is sent as one push when they end")
        case .capped:
            return text("这次检查到了单次费用上限，没看完的下次接着看", ja: "今回の確認が 1 回分の費用上限に達しました。残りは次回確認します", en: "This check hit its spending limit; the rest is read in the next check")
        case .cappedDaily:
            return text("今天累计到了每日费用上限：模型停到 0:00，规则照常，对话不受影响", ja: "今日の累計が 1 日の費用上限に達しました。モデルは 0:00 まで停止し、ルールは継続、チャットへの影響はありません", en: "Today’s spending reached the daily limit. The model is paused until 0:00, rules keep running, and chat is unaffected")
        case .modelMalformed:
            return text("模型返回的格式不对，这批邮件下次重看，没有推送", ja: "モデルの回答の形式が正しくありませんでした。通知はせず、次回同じメールを確認し直します", en: "The model’s answer was malformed. Nothing was pushed, and these emails are read again next time")
        case .modelCutOff:
            return text("模型想得太久，回答被截断，没有推送，下次把邮件分小批重看", ja: "モデルが考え込みすぎて、回答が途中で切れました。通知はせず、次回はメールを小分けにして確認し直します", en: "The model thought for too long and its answer was cut off. Nothing was pushed, and these emails are read again in smaller groups next time")
        case .modelUnfinished:
            return text("模型没有答完（超时或中断），这批邮件下次重看，没有推送", ja: "モデルが最後まで回答しませんでした（タイムアウトまたは中断）。通知はせず、次回同じメールを確認し直します", en: "The model did not finish (timed out or was interrupted). Nothing was pushed, and these emails are read again next time")
        case .modelNoAnswer:
            return text("模型这次没有回答，这批邮件下次重看，没有推送", ja: "モデルから回答がありませんでした。通知はせず、次回同じメールを確認し直します", en: "The model gave no answer this time. Nothing was pushed, and these emails are read again next time")
        case .readFailed:
            return text("读 Gmail 失败，这次不推送，15 分钟后照常再看", ja: "Gmail の読み取りに失敗しました。今回は通知せず、15 分後に再確認します", en: "Could not read Gmail. Nothing was pushed; the next check runs in 15 minutes")
        case .noMail:
            return text("没有新邮件", ja: "新着メールなし", en: "No new mail")
        case .allSkipped(let count):
            return text("\(count) 封新邮件，都是垃圾邮件，按规则跳过，没交给模型", ja: "新着 \(count) 通。すべて迷惑メールのためルールでスキップし、モデルには送っていません", en: "\(count) new \(count == 1 ? "email" : "emails"), all spam, skipped by rule and not sent to the model")
        case .floorRaised(let fetched, let raised):
            return text("\(fetched) 封新邮件，其中 \(raised) 封按“重要来信不放过”的规则留在提醒页", ja: "新着 \(fetched) 通。うち \(raised) 通は「重要なメールは見逃さない」ルールでリマインダーに残しました", en: "\(fetched) new \(fetched == 1 ? "email" : "emails"); \(raised) kept on Reminders by the “never drop important mail” rule")
        case .quiet(let fetched, let skipped):
            return text("\(fetched) 封新邮件\(skipped > 0 ? "，\(skipped) 封垃圾邮件按规则跳过" : "")，没有要紧的", ja: "新着 \(fetched) 通。\(skipped > 0 ? "\(skipped) 通は迷惑メールのためルールでスキップ、" : "")急ぎはなし", en: "\(fetched) new \(fetched == 1 ? "email" : "emails")\(skipped > 0 ? ", \(skipped) spam skipped by rule" : ""), nothing urgent")
        }
    }

    static func proactiveJudged(_ decision: ProactiveDecision) -> String {
        let counts = decision.counts
        return text(
            "模型读了 \(counts.judged) 封：要处理 \(counts.act) · 要看原信 \(counts.check) · 值得知道 \(counts.know)",
            ja: "モデルが \(counts.judged) 通を確認：対応 \(counts.act) · 要確認 \(counts.check) · 参考 \(counts.know)",
            en: "The model read \(counts.judged): \(counts.act) to do · \(counts.check) to check · \(counts.know) good to know"
        )
    }

    static var proactiveOpened: String { text("你点开了", ja: "開きました", en: "You opened it") }

    static func sourceDaily(_ value: Int) -> String {
        text("每天最多处理 \(value) 件", ja: "1 日に最大 \(value) 件を処理", en: "Up to \(value) a day")
    }
    static func sourcePerCheck(_ value: Int) -> String {
        text("每次检查最多处理 \(value) 件", ja: "1 回の確認で最大 \(value) 件を処理", en: "Up to \(value) per check")
    }
    static func sourceUsedToday(_ used: Int, resets: Date?) -> String {
        guard let resets else {
            return text("今天已处理 \(used) 件", ja: "今日 \(used) 件を処理済み", en: "\(used) handled today")
        }
        let time = resets.formatted(date: .omitted, time: .shortened)
        return text(
            "今天已处理 \(used) 件，到上限后等到 \(time) 重置",
            ja: "今日 \(used) 件を処理済み。上限に達したら \(time) のリセットまで待ちます",
            en: "\(used) handled today. At the limit it waits for the \(time) reset"
        )
    }
    static var sourcePerCheckNote: String {
        text("到了的留到下次检查", ja: "超えた分は次回の確認へ", en: "The rest wait for the next check")
    }
    static var sourceSwitch: String { text("检查这个来源", ja: "この情報源を確認する", en: "Check this source") }
    static var sourcesNone: String { text("没有可设置的来源", ja: "設定できる情報源はありません", en: "No sources to set") }

    static func weeklyPeriod(_ start: String, _ end: String) -> String { "\(start) – \(end)" }
    static var weeklyNotStarted: String {
        text("还没开始观察。数据起点要在网页上设。", ja: "まだ観察を始めていません。データの起点はウェブで設定します。", en: "Observation hasn’t started. Set the data start day on the web.")
    }
    static var weeklyNotFull: String {
        text("观察期还没满 7 天，先不算比例", ja: "観察期間が 7 日に満たないため、割合はまだ出しません", en: "The observation period is under 7 days, so no ratios yet")
    }
    static var weeklyEmpty: String {
        text("这段时间没有决策记录", ja: "この期間に判断の記録はありません", en: "No decisions recorded in this period")
    }
    static var weeklyDefinition: String {
        text("分母是你评过的条数", ja: "分母は採点した件数です", en: "The denominator is the number you rated")
    }
    static func weeklyCounts(total: Int, rated: Int) -> String {
        text("共 \(total) 条 · 你评过 \(rated) 条", ja: "\(total) 件 · 採点 \(rated) 件", en: "\(total) decisions · \(rated) rated")
    }
    static func weeklyFew(rated: Int, minimum: Int) -> String {
        text("样本不足（评过 \(rated) 条，至少 \(minimum) 条才算比例）", ja: "件数不足（採点 \(rated) 件、割合には \(minimum) 件以上必要）", en: "Too few rated (\(rated); ratios need \(minimum))")
    }
    static func weeklyFigure(_ name: String, _ figure: ProactiveWeeklyFigure) -> String {
        figure.percent.map { "\(name) \(figure.count) · \($0)%" } ?? "\(name) \(figure.count)"
    }

    static func weeklyGroup(_ group: String) -> String {
        switch group {
        case "proactive_pushed": text("读完邮件提醒了你", ja: "メールを読んで通知した", en: "Read mail and reminded you")
        case "proactive_silent": text("读完邮件没提醒", ja: "メールを読んで通知しなかった", en: "Read mail, no reminder")
        case "memory_skipped": text("系统没存下的记忆", ja: "システムが保存しないと判断した記憶", en: "Memories the system chose not to save")
        case "memory_kept": text("已存的记忆", ja: "保存した記憶", en: "Saved memories")
        case "consolidation": text("整理记忆", ja: "記憶の整理", en: "Memory tidy-up")
        case "memory_pending": text("待你确认的记忆", ja: "確認待ちの記憶", en: "Memories awaiting your confirmation")
        case "context_truncation": text("回答时没带上的旧内容", ja: "回答に入れなかった古い内容", en: "Older content left out of an answer")
        case "retrieval_degrade": text("记忆搜索没生效", ja: "記憶検索が働かなかった", en: "Memory search did not work")
        case "rule_review": text("硬规则待重审", ja: "ハードルールの再確認待ち", en: "Hard rule waiting for review")
        case "memory_capture_failed": text("记忆抽取失败", ja: "記憶の抽出に失敗", en: "Memory capture failed")
        default: text("外部程序读取记忆", ja: "外部プログラムによる記憶の読み取り", en: "Memory read by an outside program")
        }
    }

    static func weeklyRating(group: String, _ rating: ProactiveRating) -> String {
        switch (group, rating) {
        case ("proactive_pushed", .useful): text("提醒得对", ja: "通知は正しかった", en: "Right to remind")
        case ("proactive_pushed", .unneeded): text("不该提醒", ja: "通知すべきではなかった", en: "Shouldn’t have reminded")
        case ("proactive_silent", .useful): text("不提醒是对的", ja: "通知しないのが正しかった", en: "Right to stay silent")
        case ("proactive_silent", .missed): text("该提醒没提醒", ja: "通知すべきだった", en: "Should have reminded")
        case ("memory_skipped", .useful): text("不存是对的", ja: "保存しないのが正しかった", en: "Right not to save")
        case ("memory_skipped", .missed): text("该存没存", ja: "保存すべきだった", en: "Should have saved")
        case ("memory_kept", .useful): text("存对了", ja: "正しく保存した", en: "Saved correctly")
        case ("memory_kept", .unneeded): text("不该存", ja: "保存すべきではなかった", en: "Shouldn’t have saved")
        case ("consolidation", .useful): text("整理得对", ja: "整理は正しかった", en: "Right tidy-up")
        case ("consolidation", .unneeded): text("不该整理", ja: "整理すべきではなかった", en: "Shouldn’t have tidied")
        case ("memory_capture_failed", .useful): text("没漏掉什么", ja: "失ったものはない", en: "Nothing was lost")
        case ("memory_capture_failed", .missed): text("漏了该记的", ja: "覚えるべきことを逃した", en: "Lost something worth keeping")
        default: proactiveRating(rating)
        }
    }
}
