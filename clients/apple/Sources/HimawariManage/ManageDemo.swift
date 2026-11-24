#if DEBUG
import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

public enum ManageDemoScreen: String, CaseIterable, Sendable {
    case memory = "05-memory"
    case memoryDetail = "06-memory-detail"
    case memoryEdit = "18-memory-more-1-edit"
    case rules = "18-memory-more-2-rules"
    case ruleDetail = "18-memory-more-3-rule-detail"
    case settings = "08-settings"
    case device = "19-settings-more-1-device"
    case deviceAbilities = "19-settings-more-1-abilities"
    case addDevice = "19-settings-more-2-add-device"
    case addDeviceAsking = "19-settings-more-3-new-device"
    case addDeviceExpired = "19-settings-more-4-code-expired"
    case files = "19-settings-more-5-files"
    case exportPacking = "19-settings-more-6-export-packing"
    case exportReady = "19-settings-more-7-export-ready"
    case capabilities = "20-himawari-self-1-capabilities"
    case capabilitiesReactivated = "20-himawari-self-1b-capabilities-reactivated"
    case capabilitiesReactivateFailed = "20-himawari-self-1c-capabilities-reactivate-failed"
    case loginBrowsers = "20-himawari-self-2-login-browsers"
    case proposals = "20-himawari-self-3-proposals"
    case notifications = "19-settings-more-4-notifications"
    case notificationsEdit = "19-settings-more-4-notifications-edit"
    case thinkSettings = "20-himawari-self-4-think"
    case her = "next-3-her"
    case herPrivacy = "next-3-her-privacy"
    case herDevices = "next-3-her-devices"
}

public struct ManageDemoView: View {
    let screen: ManageDemoScreen

    public init(_ screen: ManageDemoScreen) {
        self.screen = screen
    }

    public var body: some View {
        switch screen {
        case .memory:
            MemoryRootView(store: ManageDemo.memoryStore())
        case .memoryDetail:
            MemoryRootView(store: ManageDemo.memoryStore(), opening: .memory("m1"))
        case .memoryEdit:
            MemoryRootView(store: ManageDemo.memoryStore(), opening: .edit("m5"))
        case .rules:
            MemoryRootView(store: ManageDemo.memoryStore(), tab: .rules)
        case .ruleDetail:
            MemoryRootView(store: ManageDemo.memoryStore(), tab: .rules, opening: .rule("r1"))
        case .settings:
            SettingsRootView(store: ManageDemo.settingsStore()) {}
        case .device:
            SettingsRootView(store: ManageDemo.settingsStore(), path: [.device(ManageDemo.macId)]) {}
        case .deviceAbilities:
            SettingsRootView(store: ManageDemo.settingsStore(), actions: .demo(), path: [.device(ManageDemo.phoneId)]) {}
        case .capabilities:
            SettingsRootView(store: ManageDemo.settingsStore(), path: [.capabilities]) {}
                .environment(\.pairingClock, ManageDemo.frozenNow)
        case .capabilitiesReactivated:
            SettingsRootView(store: ManageDemo.settingsStore(reactivated: true), path: [.capabilities]) {}
                .environment(\.pairingClock, ManageDemo.frozenNow)
        case .capabilitiesReactivateFailed:
            SettingsRootView(store: ManageDemo.reactivationFailedStore(), path: [.capabilities]) {}
                .environment(\.pairingClock, ManageDemo.frozenNow)
        case .files:
            SettingsRootView(store: ManageDemo.settingsStore(), path: [.files]) {}
        case .exportPacking:
            exporting(.packing(DataExportProgress(textsRead: 214, textsTotal: 346)))
        case .exportReady:
            exporting(.ready(ManageDemo.exportResult))
        case .loginBrowsers:
            SettingsRootView(store: ManageDemo.settingsStore(), path: [.loginBrowsers]) {}
        case .proposals:
            SettingsRootView(store: ManageDemo.settingsStore(), path: [.proposals]) {}
        case .notifications:
            SettingsRootView(store: ManageDemo.settingsStore(), path: [.tuningList(.delivery)]) {}
        case .notificationsEdit:
            SettingsRootView(store: ManageDemo.settingsStore(), path: [.tuningList(.delivery), .tuningEdit(.delivery, "busyAtLeastPermille")]) {}
        case .thinkSettings:
            SettingsRootView(store: ManageDemo.settingsStore(), path: [.tuningList(.think)]) {}
        case .her:
            her([])
        case .herPrivacy:
            her([.privacy])
        case .herDevices:
            her([.devices])
        case .addDevice:
            pairing(.showing(link: ManageDemo.link, expiresAt: ManageDemo.frozenNow.addingTimeInterval(581)))
        case .addDeviceAsking:
            pairing(.asking(ManageDemo.newcomer))
        case .addDeviceExpired:
            pairing(.expired(minutes: 10))
        }
    }

    private func her(_ path: [HerPage.Page]) -> some View {
        HerPage(
            settings: ManageDemo.settingsStore(),
            memory: ManageDemo.memoryStore(),
            listening: DemoListening(),
            senses: AnyView(EmptyView()),
            path: path
        )
    }

    private func exporting(_ stage: DataExportStage) -> some View {
        NavigationStack {
            DataExportPage(session: DataExportSession(gateway: ManageDemo.gateway(), fixed: stage)) {}
                .environment(\.pairingClock, ManageDemo.frozenNow)
        }
    }

    private func pairing(_ stage: PairingStage) -> some View {
        let store = ManageDemo.settingsStore()
        return NavigationStack {
            AddDevicePage(store: store, session: PairingSession(store: store, fixed: stage)) {}
                .environment(\.pairingClock, ManageDemo.frozenNow)
        }
    }
}

@MainActor
final class DemoListening: HerListening {
    let isListening = true
    let hasVoiceprint = true
    func stop() {}
    func deleteVoiceprint() {}
}

enum ManageDemo {
    static let frozenNow = Date(timeIntervalSince1970: 1_794_000_000)
    static let phoneId = "dev_demoPhone000000000000"
    static let macId = "dev_demoMac00000000000000"
    static let link = PairingInvitation(
        origin: URL(string: "https://himawari.example.com")!,
        code: "AAAAAAAAAAAAAAAAAAAAAA",
        access: nil
    ).link

    static let newcomer = PairedDevice(
        id: "dev_demoNew00000000000000",
        revision: 0,
        kind: "mac",
        name: "MacBook Pro",
        releaseChannel: "mac_direct",
        status: "pending",
        pairedAt: "2026-11-12T00:00:00Z",
        lastSeenAt: nil,
        pairingNumber: "482913"
    )

    @MainActor static func memoryStore() -> MemoryStore {
        MemoryStore(gateway: gateway())
    }

    @MainActor static func reactivationFailedStore() -> SettingsStore {
        let store = settingsStore()
        store.noteReactivationFailure(M.reactivateFailed, for: "cap-photos")
        return store
    }

    @MainActor static func settingsStore(reactivated: Bool = false) -> SettingsStore {
        SettingsStore(
            gateway: gateway(reactivated: reactivated),
            identity: DeviceIdentity(deviceId: phoneId, origin: URL(string: "https://himawari.example.com")!, access: nil)
        )
    }

    static let exportResult = DataExportResult(
        downloadPath: "/api/data-export/v1/archive?exportId=data-export:AAAAAAAAAAAAAAAAAAAAAA",
        fileName: "himawari-export.zip",
        sizeBytes: 48_000_000,
        sha256: String(repeating: "0", count: 64),
        memories: 1280,
        rules: 12,
        withheld: 3,
        expiresAt: ISO8601DateFormatter().string(from: frozenNow.addingTimeInterval(7 * 86_400 - 3_600))
    )

    static func gateway(reactivated: Bool = false) -> ManageGateway {
        ManageGateway(transport: DemoTransport(reactivated: reactivated), makeIdentifier: { UUID().uuidString })
    }

    static func answer(_ type: String) -> String {
        switch type {
        case "memory.overview.read": memories
        case "memory.rules.read": rules
        case "device.list.read": devices
        case "server.status.read":
            #"{"payload":{"live":true,"ready":true,"status":"healthy","dependencies":[],"generatedAt":"2026-11-12T00:00:00Z"}}"#
        case "login.devices.read": loginDevices
        case "proposals.read": proposals
        case "think.settings.read": tuning(think: true)
        case "delivery_timing.settings.read": tuning(think: false)
        case "capability.list":
            #"{"payload":{"itemRefs":["cap-calendar","cap-search","cap-mail","cap-photos"],"nextCursor":null}}"#
        default: "{}"
        }
    }

    static func capability(_ ref: String, reactivated: Bool = false) -> String {
        let (name, lifecycle) = switch ref {
        case "cap-calendar": ("日历", "update_proposed")
        case "cap-search": ("网页搜索", "active")
        case "cap-photos": ("相册整理", reactivated ? "active" : "disabled")
        default: ("邮件", "active")
        }
        var assessment = ref == "cap-calendar" ? #","updateAssessment":{"expansions":["改日程"]}"# : ""
        if lifecycle == "disabled" {
            let at = "2026-11-06T15:10:00+09:00"
            assessment = #","lastInvalidation":{"lifecycle":"disabled","cancelledScheduledJobs":2,"occurredAt":"\#(at)"}"#
        }
        return #"{"payload":{"capabilityRef":"\#(ref)","displayName":"\#(name)","lifecycle":"\#(lifecycle)","revision":1\#(assessment)}}"#
    }

    static func files(origin: String) -> String {
        let items = origin == "uploaded"
            ? [file("u1", "会议白板.jpg", kind: "image", origin: origin, daysAgo: 3, thread: nil)]
            : [file("f1", "报价单 11 月.pdf", kind: "pdf", origin: origin, daysAgo: 1, thread: "周五去大阪"), file("f2", "大阪行程.md", kind: "document", origin: origin, daysAgo: 1, thread: nil)]
        return #"{"payload":{"files":[\#(items.joined(separator: ","))],"nextCursor":null,"generatedAt":"2026-11-12T00:00:00Z"}}"#
    }

    private static func file(_ id: String, _ name: String, kind: String, origin: String, daysAgo: Double, thread: String?) -> String {
        let at = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-daysAgo * 86_400))
        let title = thread.map { #""\#($0)""# } ?? "null"
        return #"{"fileId":"\#(id)","threadId":"t1","threadTitle":\#(title),"name":"\#(name)","kind":"\#(kind)","origin":"\#(origin)","mediaType":"application/octet-stream","sizeBytes":2048,"version":1,"createdAt":"\#(at)","deleted":false,"contentPath":null}"#
    }

    private static func tuning(think: Bool) -> String {
        let rows: [(String, String, String, String, Int, Int, Int, Int, Bool)] = think
            ? [
                ("yesAtLeastPermille", "值得想的门槛", "判断“值得想”至少要多有把握", "千分比", 700, 700, 501, 1000, false),
                ("noAtMostPermille", "不值得想的门槛", "判断“不值得”最多有多少把握，中间算拿不准，不想", "千分比", 300, 300, 0, 499, false),
                ("queueLimit", "排队上限", "最多同时排几件", "件", 20, 20, 1, 1000, false),
                ("dailyLimit", "每天上限", "每天最多收多少件", "件", 80, 50, 1, 10000, true),
                ("expiresAfterHours", "排队多久作废", "排队这么久还没想就作废", "小时", 48, 48, 1, 8760, false),
            ]
            : [
                ("busyAtLeastPermille", "判忙门槛", "至少多有把握才算你正忙，忙就先不打扰", "千分比", 700, 700, 500, 1000, false),
                ("recheckSeconds", "复查间隔", "扣下的通知隔多久再看一次", "秒", 120, 120, 1, 3600, false),
                ("timeoutMs", "问模型超时", "问模型判断的最长等待", "毫秒", 4000, 4000, 100, 60000, false),
                ("perMinute", "每分钟最多问几次", "每分钟最多问模型几次", "次", 12, 12, 1, 600, false),
                ("reminderMaximumDeferSeconds", "提醒最多扣多久", "提醒最多往后扣这么久", "秒", 600, 600, 0, 86400, false),
                ("maximumDeferSeconds", "其余通知最多扣多久", "其余通知最多往后扣这么久", "秒", 1800, 1800, 0, 86400, true),
            ]
        let items = rows.map { key, label, note, unit, value, def, low, high, overridden in
            let (kind, storage) = switch unit {
            case "千分比": ("ratio", "permille")
            case "秒": ("duration", "s")
            case "毫秒": ("duration", "ms")
            case "小时": ("duration", "h")
            default: ("count", "count")
            }
            return #"{"key":"\#(key)","label":"\#(label)","description":"\#(note)","unit":"\#(unit)","kind":"\#(kind)","storageUnit":"\#(storage)","value":\#(value),"defaultValue":\#(def),"minimum":\#(low),"maximum":\#(high),"overridden":\#(overridden)}"#
        }
        let enabled = think ? #""enabled":true,"# : ""
        return #"{"payload":{"revision":4,\#(enabled)"items":[\#(items.joined(separator: ","))],"generatedAt":"2026-11-15T00:00:00.000Z"}}"#
    }

    private static var proposals: String {
        let items = [
            proposal("rule:00000000000000000000000000000001", "算出门时间时，雨天多留 10 分钟", "之后出门提醒在下雨天提前 10 分钟", "这个月有 2 次下雨天你出门晚了", figure: ("出门晚了的次数", 2, "提醒送到后 10 分钟内才出门的次数")),
            proposal("rule:00000000000000000000000000000002", "开会时的提醒改成会后一起送", "会议期间的提醒先攒着，散会后一起送", "上周 5 条提醒在开会时送到，你都没看", figure: ("没看的提醒", 5, "开会时送到、之后两小时内没点开的提醒数")),
        ]
        return #"{"payload":{"proposals":[\#(items.joined(separator: ","))],"pendingCount":2,"limit":5,"expiresAfterDays":14,"opened":null,"generatedAt":"2026-11-12T00:00:00Z"}}"#
    }

    private static func proposal(_ id: String, _ summary: String, _ effect: String, _ reason: String, figure: (String, Int, String)) -> String {
        #"{"proposalId":"\#(id)","version":1,"fingerprint":"fp-\#(id)","type":"rule","summary":"\#(summary)","effect":"\#(effect)","origin":"inferred","adoptable":true,"requiresFullRead":false,"requiresPresence":false,"evidence":[{"kind":"observation","text":"\#(reason)","sources":[],"figures":[{"name":"\#(figure.0)","value":\#(figure.1),"definition":"\#(figure.2)"}]}],"proposedAt":"2026-11-10T00:00:00.000Z","expiresAt":"2026-11-24T00:00:00.000Z","refusedBefore":0}"#
    }

    private static var loginDevices: String {
        let now = ISO8601DateFormatter().string(from: Date())
        let before = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3 * 86_400))
        return #"{"payload":{"devices":[{"deviceId":"login_mac","label":"Mac 上的 Safari","firstSeenAt":"2026-11-01T00:00:00Z","lastSeenAt":"\#(now)","current":true},{"deviceId":"login_win","label":"Windows 上的 Chrome","firstSeenAt":"2026-10-20T00:00:00Z","lastSeenAt":"\#(before)","current":false}],"generatedAt":"2026-11-12T00:00:00Z"}}"#
    }

    private static func memory(
        _ id: String, _ group: String, _ text: String, inference: Bool, recordedAt: String, lastUsedAt: String?, quote: String?
    ) -> String {
        let used = lastUsedAt.map { #""\#($0)""# } ?? "null"
        let quoted = quote.map { #""\#($0)""# } ?? "null"
        return #"""
        {"memoryId":"\#(id)","revision":1,"text":"\#(text)","inference":\#(inference),"sourceThreadId":null,"sourceRefs":[],"category":"other","subCategory":"\#(group)","status":"active","recordedAt":"\#(recordedAt)","lastUsedAt":\#(used),"importBatchId":null,"history":[{"historyId":1,"kind":"created","text":"\#(text)","quote":\#(quoted),"sourceThreadId":null,"sourceDeleted":false,"at":"\#(recordedAt)"}]}
        """#
    }

    private static var memories: String {
        let items = [
            memory("m1", "出行", "从家走到车站约 18 分钟", inference: true, recordedAt: "2026-11-10T01:00:00Z", lastUsedAt: "2026-11-12T01:20:00Z", quote: nil),
            memory("m5", "出行", "坐新干线喜欢靠窗", inference: false, recordedAt: "2026-10-30T03:00:00Z", lastUsedAt: nil, quote: "以后都帮我订靠窗的"),
            memory("m2", "工作", "每周五下午和田中有例会", inference: false, recordedAt: "2026-11-03T03:00:00Z", lastUsedAt: "2026-11-07T00:00:00Z", quote: "以后每周五下午都和田中开会"),
            memory("m6", "工作", "第一次给外面的人发邮件先让我看，同事不用", inference: false, recordedAt: "2026-11-08T03:00:00Z", lastUsedAt: nil, quote: "同事就不用问我了"),
            memory("m3", "身体", "对花生过敏", inference: false, recordedAt: "2026-10-21T03:00:00Z", lastUsedAt: "2026-11-05T03:00:00Z", quote: "我花生过敏"),
        ]
        return #"{"payload":{"memories":[\#(items.joined(separator: ","))],"imports":[],"capturePaused":false}}"#
    }

    private static let rules = #"""
    {"payload":{"rules":[
      {"ruleId":"r1","type":"quiet_hours","summary":"给没发过邮件的人发信，先问我","status":"active","enforced":true,"updatedAt":"2026-10-20T03:00:00Z","quote":"第一次给谁发邮件都先让我看一眼","changes":1,"lastUsed":{"at":"2026-11-12T01:02:00Z","kind":"email","decisionId":"decision-1"},"quoteSuperseded":true,"quoteLatestMemoryId":"m6"},
      {"ruleId":"r2","type":"spend_limit","summary":"花钱超过 5000 日元先问我","status":"active","enforced":true,"updatedAt":"2026-10-28T03:00:00Z","quote":null,"changes":0,"lastUsed":null,"quoteSuperseded":false,"quoteLatestMemoryId":null}
    ]}}
    """#

    private static var devices: String {
        let seen = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-120))
        return devicesTemplate.replacingOccurrences(of: "WATCH_SEEN", with: seen)
    }

    private static let devicesTemplate = #"""
    {"payload":{"devices":[
      {"id":"dev_demoPhone000000000000","revision":1,"kind":"iphone","name":"Andy 的 iPhone","releaseChannel":"direct","status":"active","pairedAt":"2026-11-02T00:00:00Z","lastSeenAt":"2026-11-12T00:00:00Z","pairingNumber":null},
      {"id":"dev_demoWatch00000000000","revision":1,"kind":"watch","name":"Apple Watch","releaseChannel":"direct","status":"active","pairedAt":"2026-11-02T00:00:00Z","lastSeenAt":"WATCH_SEEN","pairingNumber":null},
      {"id":"dev_demoMac00000000000000","revision":1,"kind":"mac","name":"MacBook Pro","releaseChannel":"mac_direct","status":"active","pairedAt":"2026-11-02T00:00:00Z","lastSeenAt":null,"pairingNumber":null}
    ],"limits":[],"pairing":null,"generatedAt":"2026-11-12T00:00:00Z"}}
    """#
}

private actor DemoTransport: DeviceTransport {
    let reactivated: Bool

    init(reactivated: Bool = false) {
        self.reactivated = reactivated
    }

    nonisolated func download(path: String, query: [URLQueryItem]) async throws -> DeviceResponse {
        DeviceResponse(status: 200, body: Data("demo".utf8))
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"demo","expiresAt":"2999-01-01T00:00:00Z"}"#.utf8))
        }
        let body = (try? JSONDecoder().decode([String: JSONValue].self, from: json)) ?? [:]
        guard case .string(let type)? = body["type"] else { return DeviceResponse(status: 200, body: Data("{}".utf8)) }
        if type == "capability.detail", case .object(let payload)? = body["payload"], case .string(let ref)? = payload["capabilityRef"] {
            return DeviceResponse(status: 200, body: Data(ManageDemo.capability(ref, reactivated: reactivated).utf8))
        }
        if type == "files.list.read", case .object(let payload)? = body["payload"], case .string(let origin)? = payload["origin"] {
            return DeviceResponse(status: 200, body: Data(ManageDemo.files(origin: origin).utf8))
        }
        return DeviceResponse(status: 200, body: Data(ManageDemo.answer(type).utf8))
    }
}
#endif
