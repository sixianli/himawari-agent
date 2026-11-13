#if canImport(EventKit)
import EventKit
import Foundation
import HimawariCore

public final class ReminderActions: DeviceActionHandler, @unchecked Sendable {
    public let names = ["device_reminder.complete", "device_reminder.create"]
    private let store: EKEventStore
    public let permission: DevicePermission

    public init(store: EKEventStore) {
        self.store = store
        permission = CalendarPermission(entity: .reminder)
    }

    public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? {
        guard delivery.action == "device_reminder.complete" else { return [:] }
        return try reminder(delivery).map(Self.describe)
    }

    public func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        let args = delivery.args
        switch delivery.action {
        case "device_reminder.create":
            let reminder = EKReminder(eventStore: store)
            reminder.title = try args.string("title")
            reminder.notes = try args.optionalString("notes")
            if let due = try args.optionalLocalDate("due") {
                reminder.dueDateComponents = Self.components(due)
                reminder.addAlarm(EKAlarm(absoluteDate: due))
            }
            reminder.calendar = try list(named: try args.optionalString("list"))
            try store.save(reminder, commit: true)
            return Self.describe(reminder)
        case "device_reminder.complete":
            guard let reminder = try reminder(delivery) else { throw DeviceActionFailure(.targetMissing) }
            reminder.isCompleted = true
            try store.save(reminder, commit: true)
            return Self.describe(reminder)
        default:
            throw DeviceActionFailure(.notSupported)
        }
    }

    public func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading {
        let args = delivery.args
        switch delivery.action {
        case "device_reminder.complete":
            guard let found = try reminder(delivery) else { return .differs(["absent": .bool(true)]) }
            let value = Self.describe(found)
            return found.isCompleted ? .matches(value) : .differs(value)
        default:
            let known = made?["reminderId"]?.string.flatMap { store.calendarItem(withIdentifier: $0) as? EKReminder }
            let found: EKReminder?
            if let known { found = known } else { found = try await search(args) }
            guard let found else { return made == nil ? .unreadable : .differs(["absent": .bool(true)]) }
            let value = Self.describe(found)
            guard found.title == (try args.string("title")) else { return .differs(value) }
            if let due = try args.optionalLocalDate("due"), value["due"]?.string != DeviceActionTime.localText(due) { return .differs(value) }
            return .matches(value)
        }
    }

    private func reminder(_ delivery: DeviceActionDelivery) throws -> EKReminder? {
        store.calendarItem(withIdentifier: try delivery.args.string("reminderId")) as? EKReminder
    }

    private func list(named name: String?) throws -> EKCalendar {
        let writable = store.calendars(for: .reminder).filter(\.allowsContentModifications)
        if let name {
            guard let match = writable.first(where: { $0.title == name }) else { throw DeviceActionFailure(.targetMissing) }
            return match
        }
        guard let fallback = store.defaultCalendarForNewReminders() ?? writable.first else { throw DeviceActionFailure(.targetMissing) }
        return fallback
    }

    private func search(_ args: DeviceActionArguments) async throws -> EKReminder? {
        let title = try args.string("title")
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        let store = store
        let found: [String] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: (reminders ?? []).filter { $0.title == title }.map(\.calendarItemIdentifier))
            }
        }
        return found.first.flatMap { store.calendarItem(withIdentifier: $0) as? EKReminder }
    }

    static func components(_ date: Date) -> DateComponents {
        Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    }

    static func describe(_ reminder: EKReminder) -> JSONObject {
        var value: JSONObject = [
            "reminderId": .string(reminder.calendarItemIdentifier),
            "title": .string(reminder.title ?? ""),
            "completed": .bool(reminder.isCompleted),
            "list": .string(reminder.calendar?.title ?? ""),
        ]
        if let components = reminder.dueDateComponents, let due = Calendar.current.date(from: components) {
            value["due"] = .string(DeviceActionTime.localText(due))
        }
        if let notes = reminder.notes { value["notes"] = .string(notes) }
        return value
    }
}
#endif
