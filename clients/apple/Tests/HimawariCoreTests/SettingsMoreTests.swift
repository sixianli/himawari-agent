import Foundation
import HimawariCore
import Testing

struct SettingsMoreTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func wire<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private let preferencesJSON = #"{"name":"Andy","locale":"ja","accent":"teal","theme":"dark","modelRef":"m:1","thinkingLevel":"high","revision":4,"updatedAt":"2026-11-12T00:00:00Z"}"#

    @Test func preferencesChangeKeepsTheFieldsThePhoneDoesNotEdit() throws {
        let current = try decode(OwnerPreferences.self, preferencesJSON)
        let change = try #require(current.change(name: "  Sixian  ", locale: .en))
        #expect(try wire(change) == #"{"accent":"teal","expectedRevision":4,"locale":"en","modelRef":"m:1","name":"Sixian","theme":"dark","thinkingLevel":"high"}"#)
    }

    @Test func preferencesClearedNameIsSentAsNull() throws {
        let current = try decode(OwnerPreferences.self, preferencesJSON)
        let change = try #require(current.change(name: "   ", locale: nil))
        #expect(try wire(change).contains(#""name":null"#))
        #expect(try wire(change).contains(#""locale":"ja""#))
    }

    @Test func preferencesUnchangedDraftSendsNothing() throws {
        let current = try decode(OwnerPreferences.self, preferencesJSON)
        #expect(current.change(name: "Andy", locale: .ja) == nil)
        #expect(current.change(name: "Andy", locale: nil) == nil)
    }

    @Test func preferencesNeverSavedKeepsNullsAndAcceptsFirstSave() throws {
        let fresh = try decode(
            OwnerPreferences.self,
            #"{"name":null,"locale":null,"accent":null,"theme":null,"modelRef":null,"thinkingLevel":null,"revision":0,"updatedAt":null}"#
        )
        #expect(fresh.change(name: "", locale: nil) == nil)
        let change = try #require(fresh.change(name: "A", locale: .zhCN))
        #expect(try wire(change) == #"{"accent":null,"expectedRevision":0,"locale":"zh-CN","modelRef":null,"name":"A","theme":null,"thinkingLevel":null}"#)
    }

    @Test func nameIsCutAtTheServerLimit() {
        let long = String(repeating: "a", count: 60)
        #expect(OwnerPreferences.clampedName(long).utf16.count == OwnerPreferences.nameLimit)
        let wide = String(repeating: "😀", count: 30)
        #expect(OwnerPreferences.clampedName(wide).utf16.count <= OwnerPreferences.nameLimit)
    }

    private let searchJSON = #"{"revision":2,"enabled":false,"providersChanged":false,"available":true,"recipients":["https://api.example.com","https://api.example.com","https://b.example.org"],"generatedAt":"2026-11-12T00:00:00Z"}"#

    @Test func searchAuthorizationEnableCarriesRevisionAndRecipients() throws {
        let state = try decode(SearchAuthorization.self, searchJSON)
        let change = try #require(state.setting(enabled: true))
        #expect(try wire(change) == #"{"enabled":true,"expectedRevision":2,"recipients":["https://api.example.com","https://api.example.com","https://b.example.org"]}"#)
        #expect(state.recipientHosts == ["api.example.com", "b.example.org"])
    }

    @Test func searchAuthorizationRefusesToEnableWhenNotConfigured() throws {
        let unavailable = try decode(
            SearchAuthorization.self,
            #"{"revision":2,"enabled":false,"providersChanged":false,"available":false,"recipients":[]}"#
        )
        #expect(unavailable.setting(enabled: true) == nil)
        #expect(!unavailable.canSwitch)
        let enabled = try decode(
            SearchAuthorization.self,
            #"{"revision":3,"enabled":true,"providersChanged":false,"available":false,"recipients":[]}"#
        )
        #expect(enabled.canSwitch)
        #expect(enabled.setting(enabled: false)?.enabled == false)
        #expect(enabled.setting(enabled: true) == nil)
    }

    private let pushJSON = #"{"available":true,"publicKey":null,"kinds":["reminder","run"],"subscriptions":[{"subscriptionId":"s1","deviceLabel":"Mac","endpointHost":"x","locale":"en","kinds":["reminder"],"state":"active","failureCode":null,"createdAt":"2026-11-01T00:00:00Z","lastDeliveredAt":null},{"subscriptionId":"s2","deviceLabel":"Pad","endpointHost":"x","locale":"en","kinds":[],"state":"paused","failureCode":"gone","createdAt":"2026-11-01T00:00:00Z","lastDeliveredAt":"2026-11-02T00:00:00Z"}],"generatedAt":"2026-11-12T00:00:00Z"}"#

    @Test func pushKindsListAllKindsAndTheirState() throws {
        let status = try decode(PushStatus.self, pushJSON)
        #expect(status.listedKinds == ["reminder", "approval", "run"])
        #expect(status.isOn("reminder"))
        #expect(!status.isOn("approval"))
        #expect(status.activeDeviceCount == 1)
    }

    @Test func pushKindChangeOnlyWhenTheStateDiffers() throws {
        let status = try decode(PushStatus.self, pushJSON)
        #expect(status.setting("reminder", enabled: true) == nil)
        let change = try #require(status.setting("approval", enabled: true))
        #expect(try wire(change) == #"{"enabled":true,"kind":"approval"}"#)
    }

    @Test func pushUnknownKindFromServerIsStillListed() throws {
        let status = try decode(
            PushStatus.self,
            #"{"available":true,"kinds":["digest"],"subscriptions":[]}"#
        )
        #expect(status.listedKinds == ["reminder", "approval", "run", "digest"])
    }

    private let mcpJSON = #"""
    {"connections":[
    {"id":"c1","name":"Claude 桌面版","capabilities":["mcp"],"readCeiling":"private","pushPolicy":"ask","status":"active","reportedClient":"claude-ai","createdAt":"2026-11-10T00:00:00Z","updatedAt":"2026-11-10T00:00:00Z","secretRotatedAt":null,"lastSeenAt":"2026-11-14T10:00:00Z","minute":{"reads":0,"hookReads":0},"usage":{"reads":8,"readsByTool":[{"tool":"find_memories","calls":6}],"delivered":4,"empty":3,"autoReads":0,"autoDelivered":0,"modelReads":0,"memoryPushes":0,"ruleProposals":0,"ruleProposalsRateLimited":0,"failed":1,"rateLimited":0}},
    {"id":"c2","name":"Old","capabilities":["mcp"],"readCeiling":"public","pushPolicy":"ask","status":"revoked","reportedClient":null,"createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-02T00:00:00Z","secretRotatedAt":null,"lastSeenAt":null,"minute":{"reads":0,"hookReads":0},"usage":{"reads":0,"readsByTool":[],"delivered":0,"empty":0,"autoReads":0,"autoDelivered":0,"modelReads":0,"memoryPushes":0,"ruleProposals":0,"ruleProposalsRateLimited":0,"failed":0,"rateLimited":0}}],
    "window":{"fromDay":"2026-11-08","toDay":"2026-11-14","days":7},
    "limits":[{"key":"mcp.connections","value":10,"used":1}],
    "addressPath":"/api/mcp-connections/address","generatedAt":"2026-11-14T10:00:00Z"}
    """#

    @Test func mcpListsLiveBeforeRevokedAndKeepsUsageNumbers() throws {
        let list = try decode(McpConnections.self, mcpJSON)
        #expect(list.ordered.map(\.id) == ["c1", "c2"])
        #expect(list.live.count == 1)
        let first = try #require(list.connection("c1"))
        #expect(first.usage.reads == 8)
        #expect(first.usage.delivered == 4)
        #expect(first.usage.empty == 3)
        #expect(first.usage.failed == 1)
        #expect(list.window.days == 7)
    }

    @Test func mcpChangeSendsOneFieldAndExplicitNullsForTheRest() throws {
        let list = try decode(McpConnections.self, mcpJSON)
        let first = try #require(list.connection("c1"))
        let rename = try #require(first.renamed("  Claude  "))
        #expect(try wire(rename) == #"{"capabilities":null,"connectionId":"c1","name":"Claude","pushPolicy":null,"readCeiling":null,"status":null}"#)
        let ceiling = try #require(first.ceiling("sensitive"))
        #expect(try wire(ceiling) == #"{"capabilities":null,"connectionId":"c1","name":null,"pushPolicy":null,"readCeiling":"sensitive","status":null}"#)
        let pause = try #require(first.moving(to: McpConnections.paused))
        #expect(try wire(pause) == #"{"capabilities":null,"connectionId":"c1","name":null,"pushPolicy":null,"readCeiling":null,"status":"paused"}"#)
    }

    @Test func mcpRefusesNoOpAndRevokedEdits() throws {
        let list = try decode(McpConnections.self, mcpJSON)
        let first = try #require(list.connection("c1"))
        #expect(first.renamed("Claude 桌面版") == nil)
        #expect(first.renamed("   ") == nil)
        #expect(first.ceiling("private") == nil)
        #expect(first.moving(to: McpConnections.active) == nil)
        let revoked = try #require(list.connection("c2"))
        #expect(revoked.renamed("x") == nil)
        #expect(revoked.ceiling("private") == nil)
        #expect(revoked.moving(to: McpConnections.active) == nil)
    }

    @Test func mcpNameIsCutAtTheServerLimit() {
        #expect(McpConnections.clampedName(String(repeating: "名", count: 100)).count == McpConnections.nameCharacters)
    }

    private let sensitiveJSON = #"""
    {"counts":{"masked":2,"withheld":0,"notSaved":1},"items":[
    {"id":"a","threadId":"t1","source":"chat","purpose":"chat","part":"owner_message","category":"password","outcome":"masked","firstSeenAt":"2026-11-14T03:00:00Z","lastSeenAt":"2026-11-14T03:00:00Z","seenCount":3},
    {"id":"b","threadId":null,"source":"memory_capture","purpose":null,"part":"memory_candidate","category":"bank-card","outcome":"not_saved","firstSeenAt":"2026-11-14T01:00:00Z","lastSeenAt":"2026-11-14T01:00:00Z","seenCount":1},
    {"id":"c","threadId":null,"source":"mail","purpose":null,"part":"mail","category":"verification-code","outcome":"masked","firstSeenAt":"2026-11-12T01:00:00Z","lastSeenAt":"2026-11-12T01:00:00Z","seenCount":1}],
    "next":{"firstSeenAt":"2026-11-12T01:00:00Z","id":"c"},"generatedAt":"2026-11-14T10:00:00Z"}
    """#

    private var tokyo: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }

    @Test func sensitiveCountsAndFilters() throws {
        let page = try decode(SensitiveSnapshot.self, sensitiveJSON)
        #expect(page.counts.total == 3)
        #expect(SensitiveFilter.shown(for: page.counts) == [.all, .masked, .notSaved])
        #expect(SensitiveFilter.masked.count(in: page.counts) == 2)
        #expect(page.items.filter { SensitiveFilter.notSaved.accepts($0) }.map(\.id) == ["b"])
        #expect(page.items.filter { SensitiveFilter.all.accepts($0) }.count == 3)
        #expect(page.items.filter { SensitiveFilter.withheld.accepts($0) }.isEmpty)
    }

    @Test func sensitiveItemsGroupByLocalDay() throws {
        let page = try decode(SensitiveSnapshot.self, sensitiveJSON)
        let days = SensitiveRecords.grouped(page.items, filter: .all, calendar: tokyo)
        #expect(days.map { $0.items.map(\.id) } == [["a", "b"], ["c"]])
        let masked = SensitiveRecords.grouped(page.items, filter: .masked, calendar: tokyo)
        #expect(masked.map { $0.items.map(\.id) } == [["a"], ["c"]])
    }

    @Test func sensitiveNextPageIsAppendedWithoutDuplicates() throws {
        let page = try decode(SensitiveSnapshot.self, sensitiveJSON)
        let more = try decode(
            SensitiveSnapshot.self,
            #"{"counts":{"masked":2,"withheld":0,"notSaved":1},"items":[{"id":"c","threadId":null,"source":"mail","part":"mail","category":"verification-code","outcome":"masked","firstSeenAt":"2026-11-12T01:00:00Z","seenCount":1},{"id":"d","threadId":null,"source":"mail","part":"mail","category":"password","outcome":"masked","firstSeenAt":"2026-11-11T01:00:00Z","seenCount":1}],"next":null}"#
        )
        #expect(SensitiveRecords.appended(more, to: page.items).map(\.id) == ["a", "b", "c", "d"])
        #expect(page.next == SensitiveCursor(firstSeenAt: "2026-11-12T01:00:00Z", id: "c"))
    }

    private let museJSON = #"""
    {"channel":{"state":"ok","lastBatchAt":"2026-11-14T00:00:00Z","gapCount":0},"receivedWeek":5,"suppressedWeek":1,"pending":2,
    "delay":{"medianMinutes":150,"samples":12},
    "items":[
    {"kind":"proactive","naturalKey":"k1","occurredAt":"2026-11-13T00:00:00Z","title":"出门","text":"该出门了","withheld":false,"timingOk":null,"contentOk":null},
    {"kind":"scheduled","naturalKey":"k2","occurredAt":"2026-11-12T00:00:00Z","title":null,"text":null,"withheld":true,"timingOk":true,"contentOk":false}],
    "generatedAt":"2026-11-14T10:00:00Z"}
    """#

    @Test func museRatingNeedsBothSidesOrNeither() throws {
        let overview = try decode(MuseOverview.self, museJSON)
        let open = overview.items[0]
        #expect(!open.isRated)
        #expect(open.rating(timing: true, content: nil) == nil)
        let both = try #require(open.rating(timing: true, content: false))
        #expect(try wire(both) == #"{"contentOk":false,"kind":"proactive","naturalKey":"k1","timingOk":true}"#)
        let rated = overview.items[1]
        #expect(rated.isRated)
        let undo = try #require(rated.rating(timing: nil, content: nil))
        #expect(try wire(undo) == #"{"contentOk":null,"kind":"scheduled","naturalKey":"k2","timingOk":null}"#)
        #expect(rated.rating(timing: true, content: false) == nil)
    }

    @Test func museDelayIsShownInMinutesUnderTwoHours() throws {
        let overview = try decode(MuseOverview.self, museJSON)
        let delay = try #require(overview.delay)
        let parts = MuseOverview.delayParts(minutes: delay.medianMinutes)
        #expect(parts.unit == .hours)
        #expect(parts.value == 2.5)
        #expect(MuseOverview.delayParts(minutes: 45).unit == .minutes)
        #expect(MuseOverview.delayParts(minutes: 45).value == 45)
    }

    @Test func musePausedChannelAndIntakeBody() throws {
        let paused = try decode(MuseChannel.self, #"{"state":"paused","lastBatchAt":null,"gapCount":0}"#)
        #expect(paused.isPaused)
        #expect(try wire(MuseIntakeChange(paused: true)) == #"{"paused":true}"#)
    }
}
