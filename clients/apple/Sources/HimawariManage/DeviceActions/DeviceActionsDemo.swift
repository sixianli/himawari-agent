#if DEBUG
import Foundation
import HimawariCore

public extension DeviceActionsModel {
    static func demo(empty: Bool = false) -> DeviceActionsModel {
        guard !empty else {
            return DeviceActionsModel(pending: [], handled: [], recent: [], policy: nil, permissions: [])
        }
        return DeviceActionsModel(
            pending: DeviceActionsDemo.pending,
            handled: DeviceActionsDemo.handled,
            recent: DeviceActionsDemo.recent,
            policy: DeviceActionsDemo.policy,
            permissions: DeviceActionsDemo.permissions,
            sourceNames: DeviceActionsDemo.sourceNames
        )
    }

    static var demoPermission: PermissionState { DeviceActionsDemo.permissions[0] }
    static var demoDeniedPermission: PermissionState { DeviceActionsDemo.permissions[2] }
}

enum DeviceActionsDemo {
    static func decode<T: Decodable>(_ json: String) -> T {
        do {
            return try JSONDecoder().decode(T.self, from: Data(json.utf8))
        } catch {
            preconditionFailure("demo fixture does not decode: \(error)")
        }
    }

    static let pending: [PendingApproval] = decode("""
    [
      {"approvalRequestId":"apr_demo_alarm","revision":1,"status":"pending","semanticSnapshotHash":"h1","finalRisk":"medium",
       "recentAuthenticationRequired":false,"requestedAt":"2026-11-13T06:40:00.000Z","expiresAt":"2026-11-13T06:50:00.000Z","decidedAt":null,
       "display":{"displayTitle":"用 Himawari 的闹钟定在明早 7:00","bodyPreview":"标题：去机场","askedBecause":{"kind":"no_rule_allows"},
                  "origin":{"threadId":"thr_demo_osaka","threadTitle":"大阪出差"}},
       "intent":{"capabilityRef":"device:alarm.set","operation":"alarm.set","threadId":"thr_demo_osaka","runId":"run_demo"},
       "confirmLabel":{"zh-CN":"定好","en":"Set it","ja":"セットする"}},
      {"approvalRequestId":"apr_demo_delete","revision":1,"status":"pending","semanticSnapshotHash":"h2","finalRisk":"high",
       "recentAuthenticationRequired":true,"requestedAt":"2026-11-13T06:38:00.000Z","expiresAt":"2026-11-13T06:48:00.000Z","decidedAt":null,
       "display":{"displayTitle":"删掉日历里 11 月 14 日 15:00 的“牙医复诊”","bodyPreview":"这一次，不动以后的",
                  "askedBecause":{"kind":"rule","ruleText":"删日历上的事要先问我"},
                  "origin":{"threadId":"thr_demo_dentist","threadTitle":"改牙医时间"}},
       "intent":{"capabilityRef":"device:calendar.delete","operation":"calendar.delete","threadId":"thr_demo_dentist","runId":"run_demo2"},
       "confirmLabel":{"zh-CN":"删掉","en":"Delete","ja":"削除"},
       "declineLabel":{"zh-CN":"不删","en":"Keep it","ja":"残す"}}
    ]
    """)

    static let handled: [PendingApproval] = decode("""
    [
      {"approvalRequestId":"apr_demo_done","revision":2,"status":"approved","semanticSnapshotHash":"h3","finalRisk":"medium",
       "recentAuthenticationRequired":false,"requestedAt":"2026-11-13T05:10:00.000Z","expiresAt":"2026-11-13T05:20:00.000Z","decidedAt":"2026-11-13T05:11:00.000Z",
       "display":{"displayTitle":"提醒事项里加“买转换插头”","askedBecause":{"kind":"no_rule_allows"}},
       "intent":{"capabilityRef":"device:device_reminder.create","operation":"device_reminder.create","threadId":"thr_demo_osaka","runId":"run_demo3"}},
      {"approvalRequestId":"apr_demo_late","revision":2,"status":"expired","semanticSnapshotHash":"h4","finalRisk":"medium",
       "recentAuthenticationRequired":false,"requestedAt":"2026-11-12T22:00:00.000Z","expiresAt":"2026-11-12T22:10:00.000Z","decidedAt":"2026-11-12T22:10:00.000Z",
       "display":{"displayTitle":"把客厅灯调到 30%","askedBecause":{"kind":"no_rule_allows"}},
       "intent":{"capabilityRef":"device:home.control","operation":"home.control","threadId":"thr_demo_home","runId":"run_demo4"}}
    ]
    """)

    static let recent: [DeviceActionView] = decode("""
    [
      {"id":"dact_demo1","deviceId":"dev_demo","state":"succeeded","risk":"medium","ownerPresence":false,"reversible":true,
       "createdAt":"2026-11-13T05:11:00.000Z","updatedAt":"2026-11-13T05:11:04.000Z",
       "detail":{"zh-CN":"提醒事项里加了“买转换插头”","en":"Added “Buy a plug adapter” to Reminders","ja":"リマインダーに「変換プラグを買う」を追加"}},
      {"id":"dact_demo2","deviceId":"dev_demo","state":"failed","risk":"medium","ownerPresence":false,"reversible":false,
       "createdAt":"2026-11-13T04:30:00.000Z","updatedAt":"2026-11-13T04:30:02.000Z","reasonCode":"permission",
       "reason":"这台 iPhone 没允许 Himawari 使用通讯录。要用的话，去“设置 › 隐私与安全性 › 通讯录”里打开",
       "detail":{"zh-CN":"把通讯录里“田中”的电话改成 090-1234-5678","en":"Change Tanaka's phone to 090-1234-5678","ja":"田中さんの電話番号を 090-1234-5678 に変更"}},
      {"id":"dact_demo3","deviceId":"dev_demo","state":"result_unknown","risk":"medium","ownerPresence":false,"reversible":true,
       "createdAt":"2026-11-13T04:20:00.000Z","updatedAt":"2026-11-13T04:21:00.000Z",
       "detail":{"zh-CN":"日历里加“和佐藤吃午饭”，11 月 15 日 12:00","en":"Add “Lunch with Sato” on Nov 15 at 12:00","ja":"11月15日 12:00 に「佐藤さんとランチ」を追加"}},
      {"id":"dact_demo4","deviceId":"dev_demo","state":"some_future_state","risk":"low","ownerPresence":false,"reversible":false,
       "createdAt":"2026-11-13T04:00:00.000Z","updatedAt":"2026-11-13T04:00:01.000Z","action":"future.unknown_action",
       "detail":{"zh-CN":"一件这个版本还不认识的事","en":"Something this version doesn't know yet","ja":"このバージョンがまだ知らない操作"}}
    ]
    """)

    static let policy: DevicePolicyView = decode("""
    {"revision":3,"actions":[
      {"name":"calendar.create","allowed":true,"title":{"zh-CN":"在日历里加事","en":"Add calendar events","ja":"カレンダーに予定を追加"}},
      {"name":"calendar.delete","allowed":false,"title":{"zh-CN":"删日历里的事","en":"Delete calendar events","ja":"カレンダーの予定を削除"}},
      {"name":"device_reminder.create","allowed":true,"title":{"zh-CN":"在提醒事项里加一条","en":"Add reminders","ja":"リマインダーを追加"}},
      {"name":"contact.update","allowed":true,"title":{"zh-CN":"改通讯录里的电话和邮箱","en":"Edit contact phones and emails","ja":"連絡先の電話とメールを変更"}},
      {"name":"home.control","allowed":true,"title":{"zh-CN":"开关家里的灯和设备","en":"Control home devices","ja":"家のデバイスを操作"}},
      {"name":"alarm.set","allowed":true,"title":{"zh-CN":"定闹钟","en":"Set alarms","ja":"アラームをセット"}}
    ]}
    """)

    static let sourceNames: [String: String] = [
        "alarm.set": "闹钟",
        "calendar.create": "日历",
        "calendar.delete": "日历",
        "device_reminder.create": "提醒事项",
        "contact.update": "通讯录",
        "home.control": "家庭",
    ]

    static let permissions: [PermissionState] = [
        PermissionState(id: "calendar", name: "日历", purpose: "Himawari 替你在日历里加事、改时间、删掉取消的安排。做之前会先读一遍，做完再读回来确认真的改好了。", settingsPath: "“设置 › 隐私与安全性 › 日历”", status: .notDetermined),
        PermissionState(id: "reminders", name: "提醒事项", purpose: "Himawari 替你在提醒事项里加一条，或者把做完的勾掉。", settingsPath: "“设置 › 隐私与安全性 › 提醒事项”", status: .authorized),
        PermissionState(id: "contacts", name: "通讯录", purpose: "Himawari 替你改联系人的电话和邮箱。", settingsPath: "“设置 › 隐私与安全性 › 通讯录”", status: .denied),
        PermissionState(id: "home", name: "家庭", purpose: "Himawari 替你开关家里的灯、调空调温度。", settingsPath: "“设置 › 隐私与安全性 › 家庭”", status: .authorized),
        PermissionState(id: "alarms", name: "闹钟", purpose: "Himawari 用自己的闹钟替你定时间叫你。", settingsPath: "“设置 › Himawari”", status: .notDetermined),
    ]
}
#endif
