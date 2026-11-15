import Foundation
import HimawariCore

func line(_ chinese: String, _ english: String, _ japanese: String) -> LocalizedLine {
    ["zh-CN": chinese, "en": english, "ja": japanese]
}

enum SettingsPath {
    static let app = line("“设置”App 里的 Himawari", "Settings › Himawari", "「設定」アプリの Himawari")
    static let home = line("“设置”App 里的 隐私与安全性 › 家庭", "Settings › Privacy & Security › Home", "「設定」アプリの プライバシーとセキュリティ › ホーム")
}

#if canImport(EventKit)
import EventKit

public struct CalendarPermission: DevicePermission {
    let entity: EKEntityType

    public var id: String { entity == .event ? "calendar" : "reminders" }

    public var name: LocalizedLine {
        entity == .event ? line("日历", "Calendar", "カレンダー") : line("提醒事项", "Reminders", "リマインダー")
    }

    public var settingsPath: LocalizedLine { SettingsPath.app }

    public var purpose: LocalizedLine {
        entity == .event
            ? line("你让 Himawari 建、改、删日程时，它在这台 iPhone 的日历里替你做，做完读回来核对一遍。",
                   "When you ask Himawari to add, change or delete an event, it does it in this iPhone's Calendar and reads it back to check.",
                   "予定の追加・変更・削除を頼むと、この iPhone のカレンダーで行い、読み返して確認します。")
            : line("你让 Himawari 记一件事或标成完成时，它在这台 iPhone 的“提醒事项”里替你做，做完读回来核对一遍。",
                   "When you ask Himawari to add a reminder or mark one done, it does it in this iPhone's Reminders and reads it back to check.",
                   "リマインダーの追加や完了を頼むと、この iPhone の「リマインダー」で行い、読み返して確認します。")
    }

    public func status() async -> DevicePermissionStatus {
        switch EKEventStore.authorizationStatus(for: entity) {
        case .fullAccess: .authorized
        case .notDetermined: .notDetermined
        case .restricted: .unavailable
        default: .denied
        }
    }

    public func request() async -> DevicePermissionStatus {
        if await status() != .notDetermined { return await status() }
        let asking = EKEventStore()
        _ = try? await (entity == .event ? asking.requestFullAccessToEvents() : asking.requestFullAccessToReminders())
        return await status()
    }
}
#endif

#if canImport(Contacts)
import Contacts

public struct ContactsPermission: DevicePermission {

    public var id: String { "contacts" }
    public var name: LocalizedLine { line("通讯录", "Contacts", "連絡先") }
    public var settingsPath: LocalizedLine { SettingsPath.app }
    public var purpose: LocalizedLine {
        line("你让 Himawari 改某个联系人的电话、邮箱或公司时，它在这台 iPhone 的通讯录里替你改，改之前先存一份原样。",
             "When you ask Himawari to change a contact's phone, email or company, it does it in this iPhone's Contacts and saves how it was first.",
             "連絡先の電話・メール・会社の変更を頼むと、この iPhone の連絡先で行い、変更前の状態を先に保存します。")
    }

    public func status() async -> DevicePermissionStatus {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited: .authorized
        case .notDetermined: .notDetermined
        case .restricted: .unavailable
        default: .denied
        }
    }

    public func request() async -> DevicePermissionStatus {
        if await status() != .notDetermined { return await status() }
        _ = try? await CNContactStore().requestAccess(for: .contacts)
        return await status()
    }
}
#endif
