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
    case deviceAbilities = "19-settings-more-1-abilities"
    case her = "next-3-her"
    case herApprovals = "next-3-her-approvals"
    case herPersonalization = "next-3-her-personalization"
    case herVoice = "next-3-her-voice"
    case herDataAndApps = "next-3-her-data"
    case herYourData = "next-3-her-your-data"
    case herNotificationsHub = "next-3-her-notifications-hub"
    case herDevices = "next-3-her-devices"
    case herNotifications = "next-3-her-notifications"
    case herAllowances = "next-3-her-allowances"
    case herAllowancesEmpty = "next-3-her-allowances-empty"
    case herAllowanceDays = "next-3-her-allowance-days"
    case memoryVersions = "next-4-memory-versions"
    case memoryTrash = "next-4-memory-trash"
    case herAbout = "next-6-her-about"
    case herTimers = "next-9-timers"
    case herTimersEmpty = "next-9-timers-empty"
    case herTimersReminders = "next-9-timers-reminders"
    case herTimerRecurring = "next-9-timer-recurring"
    case herTimerReminder = "next-9-timer-reminder"
    case herTimerPaused = "next-9-timer-paused"
    case herNoTimers = "next-9-her-no-timers"
    case herName = "next-10-her-name"
    case herModel = "next-10-her-model"
    case herTransfer = "next-10-her-transfer"
    case herImportPreview = "next-10-her-import-preview"
    case herServerStatus = "next-10-her-server-status"
}

public struct ManageDemoView: View {
    let screen: ManageDemoScreen

    public init(_ screen: ManageDemoScreen) {
        self.screen = screen
    }

    public var body: some View {
        switch screen {
        case .memory:
            NavigationStack { MemoryRootView(store: ManageDemo.memoryStore()) }
        case .memoryDetail:
            NavigationStack { MemoryRootView(store: ManageDemo.memoryStore(), opening: .memory("m1")) }
        case .memoryEdit:
            NavigationStack { MemoryRootView(store: ManageDemo.memoryStore(), opening: .edit("m5")) }
        case .rules:
            NavigationStack { RulesPage(store: ManageDemo.memoryStore(), quietHours: nil) }
        case .ruleDetail:
            NavigationStack { RulesPage(store: ManageDemo.memoryStore(), quietHours: nil, opening: "r1") }
        case .deviceAbilities:
            her([.devices, .device(ManageDemo.phoneId)])
        case .her:
            her([])
        case .herApprovals:
            her([.approvals])
        case .herPersonalization:
            her([.personalization], personal: true)
        case .herVoice:
            her([.voice])
        case .herDataAndApps:
            her([.dataAndApps])
        case .herYourData:
            her([.yourData])
        case .herNotificationsHub:
            her([.notificationsHub])
        case .herDevices:
            her([.devices])
        case .herNotifications:
            her([.notificationsHub, .notifications])
        case .herAllowances:
            her([.allowances])
        case .herAbout:
            her([.about])
        case .herAllowancesEmpty:
            her([.allowances], allowances: false)
        case .memoryVersions:
            NavigationStack { MemoryRootView(store: ManageDemo.memoryStore(), opening: .memory("m5")) }
        case .memoryTrash:
            NavigationStack {
                MemoryTrashPage(store: ManageDemo.loadedMemoryStore()) {}
            }
        case .herTimers:
            her([.timers])
        case .herTimersEmpty:
            her([.timers], timers: .demo([]))
        case .herTimersReminders:
            her([.timers], timers: .demo(TimersStore.demoTimers().filter { $0.kind == .reminder }))
        case .herTimerRecurring:
            her([.timers, .timer(TimersStore.demoNewsId)])
        case .herTimerReminder:
            her([.timers, .timer(TimersStore.demoRentId)])
        case .herTimerPaused:
            her([.timers, .timer(TimersStore.demoTanakaId)])
        case .herNoTimers:
            her([], timers: TimersStore(timers: nil))
        case .herName:
            her([.personalization, .name], personal: true)
        case .herModel:
            her([.personalization, .model], personal: true)
        case .herTransfer:
            her([.yourData, .importData])
        case .herImportPreview:
            her([.yourData, .importData, .importPreview], memoryImport: ManageDemo.previewedImport())
        case .herServerStatus:
            her([.about, .serverStatus])
        case .herAllowanceDays:
            AllowanceDaysSheet(days: 7) { _ in }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .himawariScreenBackground()
        }
    }

    private func her(_ path: [HerPage.Page], allowances: Bool = true, timers: TimersStore = .demo(), memoryImport: MemoryImportStore? = nil, personal: Bool = false) -> some View {
        HerPage(
            settings: ManageDemo.settingsStore(),
            memory: ManageDemo.memoryStore(allowances: allowances),
            quietHours: QuietHoursStore(gateway: ManageDemo.gateway()),
            timers: timers,
            personal: personal ? ManageDemo.personalStore() : nil,
            files: OwnerFilesStore(files: []),
            gateway: ManageDemo.gateway(),
            memoryImport: memoryImport,
            listening: DemoListening(),
            actions: .demo(),
            path: path
        )
    }
}

@MainActor
final class DemoListening: HerListening {
    let hasVoiceprint = true
    let isListening = false
    func deleteVoiceprint() {}
    func stop() {}
}

extension TimersStore {
    static let demoRentId = "timer-rent"
    static let demoNewsId = "timer-news"
    static let demoTanakaId = "timer-tanaka"

    static func demo(_ timers: [OwnerTimer] = demoTimers()) -> TimersStore {
        TimersStore(timers: timers)
    }

    static func demoTimers(now: Date = Date(), calendar: Calendar = .current) -> [OwnerTimer] {
        func at(days: Int, _ hour: Int, _ minute: Int = 0) -> Date {
            let day = calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: now)) ?? now
            return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
        }
        return [
            OwnerTimer(timerId: "timer-gone", kind: .followUp, title: "问房东修空调", task: "问房东修空调", schedule: "周四", createdBy: .her, status: .cancelled, runBudgetMicros: 50_000, createdAt: at(days: -10, 9)),
            OwnerTimer(timerId: "timer-done", kind: .reminder, title: "拿快递", task: "拿快递", schedule: "昨天 18:00", createdBy: .owner, status: .finished, lastAt: at(days: -1, 18), runCount: 1, createdAt: at(days: -2, 9)),
            OwnerTimer(timerId: demoTanakaId, kind: .followUp, title: nil, task: "周五前没收到田中的报价单就提醒我追一下，顺便问交期", schedule: "周五 10:00", createdBy: .her, status: .paused, runBudgetMicros: 50_000, createdAt: at(days: -3, 11)),
            OwnerTimer(timerId: demoNewsId, kind: .recurring, title: "AI 新闻简报", task: "每天早上整理 AI 新闻，挑三条最重要的，每条两句话说清楚。只看英文一手来源。", ownerWords: "- 以后每天早上给我看看 AI 新闻\n- 只要英文的一手来源\n- 别超过三条\n- 每条两句话就够了\n- 周末也要", schedule: "每天 8:00", createdBy: .agreed, nextAt: at(days: 1, 8), lastAt: at(days: 0, 8), runCount: 12, spentMicros: 61_000, runBudgetMicros: 20_000, lastResult: OwnerTimer.LastResult(text: "挑了三条：一家实验室发了新的开源模型；一份报告说推理成本半年降了一半；一个编程助手加了后台运行。", at: at(days: 0, 8, 2)), createdAt: at(days: -13, 21)),
            OwnerTimer(timerId: "timer-week", kind: .recurring, title: "周报草稿", task: "每周五晚上把这周的事整理成周报草稿", schedule: "每周五 21:00", createdBy: .owner, nextAt: at(days: 3, 21), runCount: 2, spentMicros: 4_000, runBudgetMicros: 30_000, createdAt: at(days: -15, 20)),
            OwnerTimer(timerId: demoRentId, kind: .reminder, title: "交房租", task: "提醒我交房租", schedule: "下月 1 日 9:00", createdBy: .owner, nextAt: at(days: 6, 9), createdAt: at(days: -1, 22)),
            OwnerTimer(timerId: "timer-call", kind: .reminder, title: "给妈妈打电话", task: "提醒我给妈妈打电话", schedule: "今晚 20:00", createdBy: .agreed, nextAt: at(days: 0, 20), createdAt: at(days: 0, 9)),
        ]
    }
}

enum ManageDemo {
    static let phoneId = "dev_demoPhone000000000000"
    @MainActor static func memoryStore(allowances: Bool = true) -> MemoryStore {
        MemoryStore(gateway: gateway(allowances: allowances))
    }

    @MainActor static func loadedMemoryStore() -> MemoryStore {
        let store = memoryStore()
        Task { await store.load() }
        return store
    }

    @MainActor static func previewedImport() -> MemoryImportStore {
        let store = MemoryImportStore(gateway: gateway())
        Task { await store.preview(.codex, files: [MemoryImportFile(name: "MEMORY.md", text: "# User Profile")]) }
        return store
    }

    @MainActor static func settingsStore() -> SettingsStore {
        SettingsStore(directory: DemoDeviceDirectory())
    }

    @MainActor static func personalStore() -> PersonalStore {
        PersonalStore(
            gateway: gateway(),
            preferences: OwnerPreferences(name: "Andy", modelRef: "deepseek-flash", thinkingLevel: "high", revision: 3),
            models: ChatModels(defaultRef: "magpie-main", options: [
                ChatModel(ref: "magpie-main", name: "himawari-main", provider: "magpie", thinkingLevels: ["off", "low", "medium", "high"], automatic: true),
                ChatModel(ref: "deepseek-flash", name: "DeepSeek V4.1 Flash", provider: "magpie", thinkingLevels: ["off", "high"], price: .init(input: 0.1, output: 0.4), priceTier: .low),
                ChatModel(ref: "glm-flash", name: "GLM 5.3 Flash", provider: "magpie", thinkingLevels: ["off", "high"], price: .init(input: 0.2, output: 0.8), priceTier: .mid),
                ChatModel(ref: "minimax", name: "MiniMax M3", provider: "magpie", thinkingLevels: ["off"], price: .init(input: 0.4, output: 1.6), priceTier: .high),
            ])
        )
    }

    static func gateway(allowances: Bool = true) -> ManageGateway {
        ManageGateway(transport: DemoTransport(allowances: allowances), makeIdentifier: { UUID().uuidString })
    }

    static func answer(_ type: String, allowances: Bool) -> String {
        switch type {
        case "memory.overview.read": memories
        case "memory.search.read": searchHits
        case "memory.rules.read": allowances ? rules : #"{"payload":{"rules":[],"allowances":[],"allowanceDays":7}}"#
        case "server.status.read": serverStatus
        case "memory.import.preview.read": importPreview
        case "quiet_hours.read": #"{"payload":{"version":"v1","editable":true,"enabled":true,"start":"23:00","end":"07:00","classes":["scheduled_reminder","run_result","mail_reminder","her_words"],"rules":[{"ruleId":"rule-quiet","summary":"晚上 11 点到早上 7 点别推"}]}}"#
        default: "{}"
        }
    }

    static let searchHits = #"{"payload":{"query":"过敏","results":[{"kind":"memory","memoryId":"m3","ruleId":null,"text":"对花生过敏","category":"health","tentative":false,"updatedAt":"2026-10-21T03:00:00Z"},{"kind":"rule","memoryId":"m6","ruleId":"r1","text":"给没发过邮件的人发信，先问我","category":"rule","tentative":false,"updatedAt":"2026-10-20T03:00:00Z"}],"generatedAt":"2026-11-26T03:00:00Z"}}"#

    private static func memory(
        _ id: String, _ group: String, _ text: String, inference: Bool, recordedAt: String, lastUsedAt: String?, quote: String?,
        status: String = "active", updatedAt: String? = nil, earlier: (text: String, at: String)? = nil
    ) -> String {
        let used = lastUsedAt.map { #""\#($0)""# } ?? "null"
        let quoted = quote.map { #""\#($0)""# } ?? "null"
        let older = earlier.map { #"{"historyId":2,"kind":"created","text":"\#($0.text)","quote":null,"sourceThreadId":null,"sourceDeleted":false,"at":"\#($0.at)"},"# } ?? ""
        return #"""
        {"memoryId":"\#(id)","revision":1,"text":"\#(text)","inference":\#(inference),"sourceThreadId":null,"sourceRefs":[],"category":"other","subCategory":"\#(group)","status":"\#(status)","recordedAt":"\#(recordedAt)","updatedAt":"\#(updatedAt ?? recordedAt)","lastUsedAt":\#(used),"importBatchId":null,"history":[\#(older){"historyId":1,"kind":"created","text":"\#(text)","quote":\#(quoted),"sourceThreadId":null,"sourceDeleted":false,"at":"\#(recordedAt)"}]}
        """#
    }

    private static let serverStatus = #"{"payload":{"live":true,"ready":true,"status":"healthy","dependencies":[{"name":"worker","required":true,"status":"healthy","reasonCode":null}],"release":{"commit":"25bf7041","installedAt":"2026-11-26T07:40:00.000Z"},"disk":{"availableBytes":21474836480,"totalBytes":50000000000},"generatedAt":"2026-11-26T08:00:00.000Z"}}"#

    private static let importPreview = #"{"payload":{"files":[{"name":"MEMORY.md","state":"read","found":4}],"found":4,"items":[{"contentRef":"demo-a","text":"每天早上跑步","from":"MEMORY.md · User Profile","category":"preference","subCategory":null,"topic":null,"flag":null,"selectable":true,"checked":true},{"contentRef":"demo-b","text":"对花生过敏","from":"MEMORY.md · User Profile","category":"health","subCategory":null,"topic":"health","flag":"duplicate","selectable":false,"checked":false},{"contentRef":"demo-c","text":"周五下午和田中开会","from":"MEMORY.md · User Profile","category":"event","subCategory":null,"topic":null,"flag":"similar","selectable":true,"checked":false},{"contentRef":"demo-d","text":"用 pnpm 而不是 npm","from":"MEMORY.md · General Tips","category":"project","subCategory":"Codex","topic":null,"flag":"coding","selectable":true,"checked":false}]}}"#

    private static var memories: String {
        let items = [
            memory("m1", "出行", "从家走到车站约 18 分钟", inference: true, recordedAt: "2026-11-10T01:00:00Z", lastUsedAt: "2026-11-12T01:20:00Z", quote: nil),
            memory("m5", "出行", "坐新干线喜欢靠窗", inference: false, recordedAt: "2026-10-30T03:00:00Z", lastUsedAt: nil, quote: "以后都帮我订靠窗的", earlier: ("坐新干线喜欢靠过道", "2026-09-12T03:00:00Z")),
            memory("m2", "工作", "每周五下午和田中有例会", inference: false, recordedAt: "2026-11-03T03:00:00Z", lastUsedAt: "2026-11-07T00:00:00Z", quote: "以后每周五下午都和田中开会"),
            memory("m6", "工作", "第一次给外面的人发邮件先让我看，同事不用", inference: false, recordedAt: "2026-11-08T03:00:00Z", lastUsedAt: nil, quote: "同事就不用问我了"),
            memory("m3", "身体", "对花生过敏", inference: false, recordedAt: "2026-10-21T03:00:00Z", lastUsedAt: "2026-11-05T03:00:00Z", quote: "我花生过敏"),
            memory("m7", "工作", "周三早上去健身房", inference: true, recordedAt: "2026-10-02T03:00:00Z", lastUsedAt: nil, quote: nil, status: "trashed", updatedAt: "2026-11-24T03:00:00Z"),
        ]
        return #"{"payload":{"memories":[\#(items.joined(separator: ","))],"imports":[],"capturePaused":false}}"#
    }

    private static let rules = #"""
    {"payload":{"rules":[
      {"ruleId":"r1","type":"quiet_hours","summary":"给没发过邮件的人发信，先问我","status":"active","enforced":true,"updatedAt":"2026-10-20T03:00:00Z","quote":"第一次给谁发邮件都先让我看一眼","changes":1,"lastUsed":{"at":"2026-11-12T01:02:00Z","kind":"email","decisionId":"decision-1"},"quoteSuperseded":true,"quoteLatestMemoryId":"m6"},
      {"ruleId":"r2","type":"spend_limit","summary":"花钱超过 5000 日元先问我","status":"active","enforced":true,"updatedAt":"2026-10-28T03:00:00Z","quote":null,"changes":0,"lastUsed":null,"quoteSuperseded":false,"quoteLatestMemoryId":null}
    ],"allowances":[
      {"allowanceId":"allowance:a1","allowFor":"always","title":"给 田中 发邮件","operation":"mail.send","recipients":["tanaka@example.co.jp"],"threadId":null,"expiresAt":null,"createdAt":"2026-11-24T03:00:00Z"},
      {"allowanceId":"allowance:a2","allowFor":"days","title":"改日历里的工作日程","operation":"calendar.update","recipients":[],"threadId":null,"threadTitle":null,"expiresAt":"2026-12-02T03:00:00Z","createdAt":"2026-11-25T03:00:00Z"},
      {"allowanceId":"allowance:a3","allowFor":"this_task","title":"在酒店网站上填入住信息","operation":"browser.fill","recipients":[],"threadId":"thread:hotel","threadTitle":"订酒店","expiresAt":null,"createdAt":"2026-11-25T05:00:00Z"}
    ],"allowanceDays":7}}
    """#

    static let roster = #"""
    {"thisDeviceId":"dev_demoPhone000000000000","devices":[
      {"id":"dev_demoPhone000000000000","revision":1,"kind":"iphone","name":"Andy 的 iPhone","releaseChannel":"testflight","status":"active","pairedAt":"2026-11-26T00:00:00Z","lastSeenAt":"2026-11-26T00:00:00Z"},
      {"id":"dev_demoMac00000000000000","revision":3,"kind":"mac","name":"Andy 的 MacBook Air","releaseChannel":"mac_direct","status":"active","pairedAt":"2026-11-26T01:00:00Z","lastSeenAt":"2026-11-26T02:00:00Z","online":true},
      {"id":"dev_demoWatch000000000000","revision":2,"kind":"watch","name":"Apple Watch","releaseChannel":"direct","status":"active","pairedAt":"2026-11-24T00:00:00Z","lastSeenAt":null}
    ],"server":{"origin":"https://himawari.example.com","since":"2026-11-26T00:00:00Z"}}
    """#
}

private struct DemoDeviceDirectory: DeviceDirectory {
    func roster() async throws -> DeviceRoster {
        try JSONDecoder().decode(DeviceRoster.self, from: Data(ManageDemo.roster.utf8))
    }

    func rename(_ deviceId: String, expectedRevision: Int, name: String) async throws {}

    func revoke(_ deviceId: String, expectedRevision: Int, confirmReason: String?) async throws {}
}

private actor DemoTransport: DeviceTransport {
    let allowances: Bool

    init(allowances: Bool) {
        self.allowances = allowances
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"demo","expiresAt":"2999-01-01T00:00:00Z"}"#.utf8))
        }
        if path == ManageGateway.textPath {
            return DeviceResponse(status: 200, body: Data(#"{"payloadRef":"demo-upload"}"#.utf8))
        }
        let body = (try? JSONDecoder().decode([String: JSONValue].self, from: json)) ?? [:]
        guard case .string(let type)? = body["type"] else { return DeviceResponse(status: 200, body: Data("{}".utf8)) }
        return DeviceResponse(status: 200, body: Data(ManageDemo.answer(type, allowances: allowances).utf8))
    }
}
#endif
