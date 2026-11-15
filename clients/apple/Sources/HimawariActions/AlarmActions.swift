#if canImport(AlarmKit)
import AlarmKit
import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct HimawariAlarmMetadata: AlarmMetadata {}

public struct AlarmPermission: DevicePermission {
    public var id: String { "alarms" }
    public var name: LocalizedLine { line("闹钟", "Alarms", "アラーム") }
    public var settingsPath: LocalizedLine { SettingsPath.app }
    public var purpose: LocalizedLine {
        line("你让 Himawari 设闹钟时，它在这台 iPhone 上替你设，到点会像系统闹钟一样响，静音和专注模式下也响。",
             "When you ask Himawari to set an alarm, it sets it on this iPhone. It rings like a system alarm, even in silent mode or Focus.",
             "アラームを頼むと、この iPhone に設定します。消音モードや集中モードでもシステムのアラームと同じように鳴ります。")
    }

    public func status() async -> DevicePermissionStatus {
        switch AlarmManager.shared.authorizationState {
        case .authorized: .authorized
        case .notDetermined: .notDetermined
        default: .denied
        }
    }

    public func request() async -> DevicePermissionStatus {
        if await status() != .notDetermined { return await status() }
        _ = try? await AlarmManager.shared.requestAuthorization()
        return await status()
    }
}

public final class AlarmActions: DeviceActionHandler, @unchecked Sendable {
    public let names = ["alarm.set"]
    public let permission: DevicePermission = AlarmPermission()

    public init() {}

    static func alarmId(_ actionId: String) -> UUID? {
        let hex = Array(actionId.dropFirst("dact_".count))
        guard actionId.hasPrefix("dact_"), hex.count == 32 else { return nil }
        let text = String(hex)
        let parts = [text.prefix(8), text.dropFirst(8).prefix(4), text.dropFirst(12).prefix(4), text.dropFirst(16).prefix(4), text.dropFirst(20)]
        return UUID(uuidString: parts.joined(separator: "-"))
    }

    public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? { [:] }

    public func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        guard let id = Self.alarmId(delivery.id) else { throw DeviceActionFailure(.badArguments) }
        let args = delivery.args
        let date = try args.localDate("time")
        let title = try args.optionalString("label") ?? delivery.detail.localized()
        let stop = AlarmButton(text: LocalizedStringResource(stringLiteral: Self.stopTitle), textColor: Color.hmOnText, systemImageName: "stop.circle")
        let alert = AlarmPresentation.Alert(title: LocalizedStringResource(stringLiteral: title), stopButton: stop)
        let attributes = AlarmAttributes<HimawariAlarmMetadata>(presentation: AlarmPresentation(alert: alert), tintColor: Color.hmSunBright)
        let configuration = AlarmManager.AlarmConfiguration<HimawariAlarmMetadata>(schedule: .fixed(date), attributes: attributes)
        let alarm = try await AlarmManager.shared.schedule(id: id, configuration: configuration)
        return Self.describe(alarm, label: title)
    }

    public func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading {
        guard let id = Self.alarmId(delivery.id) else { return .unreadable }
        let alarms = try AlarmManager.shared.alarms
        guard let alarm = alarms.first(where: { $0.id == id }) else { return .differs(["absent": .bool(true)]) }
        let found = Self.describe(alarm, label: made?["label"]?.string)
        let wanted = try delivery.args.localDate("time")
        if case let .fixed(date) = alarm.schedule, abs(date.timeIntervalSince(wanted)) < 1 { return .matches(found) }
        return .differs(found)
    }

    static var stopTitle: String {
        switch AnswerLocale.matching(preferredLanguages: Locale.preferredLanguages) {
        case .chinese: "停止"
        case .english: "Stop"
        case .japanese: "停止"
        }
    }

    static func describe(_ alarm: Alarm, label: String?) -> JSONObject {
        var value: JSONObject = ["alarmId": .string(alarm.id.uuidString)]
        if case let .fixed(date) = alarm.schedule { value["time"] = .string(DeviceActionTime.localText(date)) }
        if let label { value["label"] = .string(label) }
        return value
    }
}
#endif
