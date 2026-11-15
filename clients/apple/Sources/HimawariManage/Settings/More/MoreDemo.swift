#if DEBUG
import Foundation

enum MoreDemo {
    static func answer(_ type: String) -> String? {
        switch type {
        case "owner.preferences.read": preferences
        case "mcp.connections.read": mcp
        case "search.authorization.read": search
        case "push.status.read": push
        case "muse.overview.read": muse
        case "sensitive.interceptions.read": sensitive
        default: nil
        }
    }

    private static let preferences =
        #"{"payload":{"name":"Andy","locale":"zh-CN","accent":"teal","theme":"system","modelRef":null,"thinkingLevel":null,"revision":3,"updatedAt":"2026-11-12T00:00:00Z"}}"#

    private static let search =
        #"{"payload":{"revision":2,"enabled":false,"providersChanged":false,"available":true,"recipients":["https://search.example.com","https://reader.example.com"],"generatedAt":"2026-11-12T00:00:00Z"}}"#

    private static let push =
        #"{"payload":{"available":true,"publicKey":null,"kinds":["reminder","approval"],"subscriptions":[{"subscriptionId":"s1","deviceLabel":"iPhone","endpointHost":"push.example.com","locale":"zh-CN","kinds":["reminder","approval"],"state":"active","failureCode":null,"createdAt":"2026-11-01T00:00:00Z","lastDeliveredAt":"2026-11-11T09:00:00Z"}],"generatedAt":"2026-11-12T00:00:00Z"}}"#

    private static func usage(reads: Int, delivered: Int, empty: Int, failed: Int) -> String {
        #"{"reads":\#(reads),"readsByTool":[],"delivered":\#(delivered),"empty":\#(empty),"autoReads":0,"autoDelivered":0,"modelReads":0,"memoryPushes":0,"ruleProposals":0,"ruleProposalsRateLimited":0,"failed":\#(failed),"rateLimited":0}"#
    }

    private static func connection(_ id: String, _ name: String, status: String, ceiling: String, seen: String?, usage: String) -> String {
        let lastSeen = seen.map { "\"" + $0 + "\"" } ?? "null"
        return #"{"id":"\#(id)","name":"\#(name)","capabilities":["mcp"],"readCeiling":"\#(ceiling)","pushPolicy":"ask","status":"\#(status)","reportedClient":null,"createdAt":"2026-11-10T00:00:00Z","updatedAt":"2026-11-10T00:00:00Z","secretRotatedAt":null,"lastSeenAt":\#(lastSeen),"minute":{"reads":0,"hookReads":0},"usage":\#(usage)}"#
    }

    private static var mcp: String {
        let items = [
            connection("c1", "Claude 桌面版", status: "active", ceiling: "private", seen: "2026-11-11T14:00:00Z", usage: usage(reads: 8, delivered: 4, empty: 3, failed: 1)),
            connection("c2", "Claude Code", status: "paused", ceiling: "public", seen: "2026-11-08T09:00:00Z", usage: usage(reads: 2, delivered: 2, empty: 0, failed: 0)),
            connection("c3", "旧的接入", status: "revoked", ceiling: "public", seen: nil, usage: usage(reads: 0, delivered: 0, empty: 0, failed: 0)),
        ]
        return #"{"payload":{"connections":[\#(items.joined(separator: ","))],"window":{"fromDay":"2026-11-06","toDay":"2026-11-12","days":7},"limits":[],"addressPath":"/api/mcp-connections/address","generatedAt":"2026-11-12T00:00:00Z"}}"#
    }

    private static func record(_ id: String, _ category: String, _ outcome: String, _ part: String, at: String, count: Int, thread: Bool) -> String {
        let threadValue = thread ? "\"t1\"" : "null"
        return #"{"id":"\#(id)","threadId":\#(threadValue),"source":"chat","purpose":null,"part":"\#(part)","category":"\#(category)","outcome":"\#(outcome)","firstSeenAt":"\#(at)","lastSeenAt":"\#(at)","seenCount":\#(count)}"#
    }

    private static var sensitive: String {
        let items = [
            record("a", "password", "masked", "owner_message", at: "2026-11-12T00:20:00Z", count: 3, thread: true),
            record("b", "bank-card", "not_saved", "memory_candidate", at: "2026-11-12T00:05:00Z", count: 1, thread: false),
            record("c", "verification-code", "masked", "mail", at: "2026-11-11T01:00:00Z", count: 1, thread: false),
        ]
        return #"{"payload":{"counts":{"masked":2,"withheld":0,"notSaved":1},"items":[\#(items.joined(separator: ","))],"next":null,"generatedAt":"2026-11-12T00:00:00Z"}}"#
    }

    private static var muse: String {
        let items = [
            #"{"kind":"proactive","naturalKey":"k1","occurredAt":"2026-11-11T09:00:00Z","title":"该出门了","text":"10 点的会议在 15 分钟后，路上要 20 分钟","withheld":false,"timingOk":null,"contentOk":null}"#,
            #"{"kind":"scheduled","naturalKey":"k2","occurredAt":"2026-11-10T09:00:00Z","title":"周报","text":"周报今天要交","withheld":false,"timingOk":true,"contentOk":false}"#,
        ]
        return #"{"payload":{"channel":{"state":"ok","lastBatchAt":"2026-11-11T23:00:00Z","gapCount":0},"receivedWeek":5,"suppressedWeek":1,"pending":1,"delay":{"medianMinutes":42,"samples":12},"items":[\#(items.joined(separator: ","))],"generatedAt":"2026-11-12T00:00:00Z"}}"#
    }
}
#endif
