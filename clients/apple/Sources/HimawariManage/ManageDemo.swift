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
    case herPrivacy = "next-3-her-privacy"
    case herDevices = "next-3-her-devices"
    case herNotifications = "next-3-her-notifications"
    case herAllowances = "next-3-her-allowances"
    case herAllowancesEmpty = "next-3-her-allowances-empty"
    case herAllowanceDays = "next-3-her-allowance-days"
    case memoryVersions = "next-4-memory-versions"
    case memoryTrash = "next-4-memory-trash"
    case herAbout = "next-6-her-about"
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
        case .deviceAbilities:
            her([.devices, .device(ManageDemo.phoneId)])
        case .her:
            her([])
        case .herApprovals:
            her([.approvals])
        case .herPrivacy:
            her([.privacy])
        case .herDevices:
            her([.devices])
        case .herNotifications:
            her([.notifications])
        case .herAllowances:
            her([.allowances])
        case .herAbout:
            her([.about])
        case .herAllowancesEmpty:
            her([.allowances], allowances: false)
        case .memoryVersions:
            MemoryRootView(store: ManageDemo.memoryStore(), opening: .memory("m5"))
        case .memoryTrash:
            NavigationStack {
                MemoryTrashPage(store: ManageDemo.loadedMemoryStore()) {}
            }
        case .herAllowanceDays:
            AllowanceDaysSheet(days: 7) { _ in }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .himawariScreenBackground()
        }
    }

    private func her(_ path: [HerPage.Page], allowances: Bool = true) -> some View {
        HerPage(
            settings: ManageDemo.settingsStore(),
            memory: ManageDemo.memoryStore(allowances: allowances),
            quietHours: QuietHoursStore(gateway: ManageDemo.gateway()),
            listening: DemoListening(),
            actions: .demo(),
            senses: AnyView(EmptyView()),
            path: path
        )
    }
}

@MainActor
final class DemoListening: HerListening {
    let hasVoiceprint = true
    func deleteVoiceprint() {}
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

    @MainActor static func settingsStore() -> SettingsStore {
        SettingsStore(
            gateway: gateway(),
            identity: DeviceIdentity(deviceId: phoneId, origin: URL(string: "https://himawari.example.com")!, access: nil)
        )
    }

    static func gateway(allowances: Bool = true) -> ManageGateway {
        ManageGateway(transport: DemoTransport(allowances: allowances), makeIdentifier: { UUID().uuidString })
    }

    static func answer(_ type: String, allowances: Bool) -> String {
        switch type {
        case "memory.overview.read": memories
        case "memory.rules.read": allowances ? rules : #"{"payload":{"rules":[],"allowances":[],"allowanceDays":7}}"#
        case "device.list.read": devices
        case "quiet_hours.read": #"{"payload":{"version":"v1","editable":true,"enabled":true,"start":"23:00","end":"07:00","classes":["scheduled_reminder","run_result","mail_reminder","her_words"],"rules":[{"ruleId":"rule-quiet","summary":"晚上 11 点到早上 7 点别推"}]}}"#
        default: "{}"
        }
    }

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

    private static let devices = #"""
    {"payload":{"devices":[
      {"id":"dev_demoPhone000000000000","revision":1,"kind":"iphone","name":"Andy 的 iPhone","releaseChannel":"direct","status":"active","pairedAt":"2026-11-02T00:00:00Z","lastSeenAt":"2026-11-12T00:00:00Z","pairingNumber":null}
    ],"limits":[],"pairing":null,"generatedAt":"2026-11-12T00:00:00Z"}}
    """#
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
        let body = (try? JSONDecoder().decode([String: JSONValue].self, from: json)) ?? [:]
        guard case .string(let type)? = body["type"] else { return DeviceResponse(status: 200, body: Data("{}".utf8)) }
        return DeviceResponse(status: 200, body: Data(ManageDemo.answer(type, allowances: allowances).utf8))
    }
}
#endif
