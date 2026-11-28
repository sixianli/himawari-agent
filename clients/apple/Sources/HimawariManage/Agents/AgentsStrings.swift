import Foundation

extension M {
    static var agentsTitle: String { text("接入的 agent", ja: "接続した agent", en: "Connected agents") }
    static var agentsLead: String {
        text(
            "别的 agent（例如 Claude、Codex）在它的 MCP 设置里填 Himawari 的地址，你在这里用面容 ID 同意后才能接入。暂停、撤销立刻生效。",
            ja: "ほかの agent（Claude や Codex など）の MCP 設定に Himawari のアドレスを入れ、ここで Face ID で承認すると接続できます。一時停止と取り消しはすぐに反映されます。",
            en: "Another agent (for example Claude or Codex) adds Himawari's address in its MCP settings, and connects once you approve here with Face ID. Pausing or revoking takes effect at once."
        )
    }
    static var agentsEmpty: String { text("还没有接入的 agent", ja: "まだ接続した agent はありません", en: "No connected agents yet") }
    static var agentPushLabel: String { text("送来记忆时", ja: "記憶を送ってきたとき", en: "When it sends memories") }
    static func agentPush(_ policy: AgentPushPolicy) -> String {
        switch policy {
        case .ask: text("先问我", ja: "先に確認する", en: "Ask me first")
        case .direct: text("直接存（随时可撤销）", ja: "すぐ保存（いつでも取り消せる）", en: "Save right away (undo anytime)")
        }
    }
    static func agentStatus(_ status: AgentStatus) -> String {
        switch status {
        case .active: text("使用中", ja: "使用中", en: "Active")
        case .paused: text("已暂停", ja: "一時停止中", en: "Paused")
        case .revoked: text("已撤销", ja: "取り消し済み", en: "Revoked")
        }
    }
    static var agentPaused: String { text("暂停", ja: "一時停止", en: "Pause") }
    static var agentRevoke: String { text("撤销接入", ja: "接続を取り消す", en: "Revoke access") }
    static var agentRevokeDetail: String {
        text("撤销后这个 agent 再也不能用这次的授权，要用得重新接入并再同意一次。", ja: "取り消すと、この agent は今回の許可を使えなくなります。使うには接続し直して、もう一度承認してください。", en: "After revoking, this agent can't use this access again. To use it, it has to connect again and you approve again.")
    }
    static func agentLastSeen(_ when: String) -> String { text("最近一次：\(when)", ja: "最後の利用：\(when)", en: "Last used: \(when)") }
    static var agentNeverSeen: String { text("还没用过", ja: "まだ使われていません", en: "Not used yet") }
    static func agentPushes(_ count: Int) -> String { text("推来记忆 \(count) 次", ja: "送られた記憶 \(count) 回", en: "Memory pushes: \(count)") }
    static var agentChangeFailed: String { text("没改成，稍后再试", ja: "変更できませんでした。あとでもう一度", en: "Couldn't change it. Try again later") }
    static func agentChangeReason(_ name: String) -> String { text("修改「\(name)」的接入设置", ja: "「\(name)」の接続設定を変更", en: "Change access settings for “\(name)”") }

    static var agentGrantTitle: String { text("有 agent 想接入", ja: "agent が接続を求めています", en: "An agent wants to connect") }
    static func agentGrantFrom(_ host: String) -> String { text("来自 \(host)", ja: "\(host) から", en: "From \(host)") }
    static func agentGrantReturnsTo(_ host: String) -> String { text("同意后回到 \(host)", ja: "承認後は \(host) に戻ります", en: "Returns to \(host) after approval") }
    static var agentGrantLocal: String { text("同意后回到对方电脑上的程序", ja: "承認後は相手のコンピュータのアプリに戻ります", en: "Returns to an app on the other computer after approval") }
    static func agentGrantReplaces(_ name: String) -> String { text("会替换已有的接入「\(name)」", ja: "既存の接続「\(name)」を置き換えます", en: "Replaces the existing access “\(name)”") }
    static var agentGrantName: String { text("名字", ja: "名前", en: "Name") }
    static var agentGrantWrite: String { text("允许它推来记忆和提议规则", ja: "記憶の送信とルールの提案を許可", en: "Let it send memories and propose rules") }
    static var agentGrantApprove: String { text("用面容 ID 同意", ja: "Face ID で承認", en: "Approve with Face ID") }
    static var agentGrantDeny: String { text("不同意", ja: "承認しない", en: "Decline") }
    static var agentGrantFailed: String { text("没发出去，可能已经过期，让对方重新接入一次", ja: "送れませんでした。期限切れの可能性があります。相手にもう一度接続してもらってください", en: "Couldn't send. It may have expired; ask the agent to connect again") }
    static func agentApproveReason(_ name: String) -> String { text("同意「\(name)」接入 Himawari", ja: "「\(name)」の Himawari への接続を承認", en: "Approve “\(name)” connecting to Himawari") }
    static func agentDenyReason(_ name: String) -> String { text("拒绝「\(name)」接入", ja: "「\(name)」の接続を拒否", en: "Decline “\(name)” connecting") }
}
