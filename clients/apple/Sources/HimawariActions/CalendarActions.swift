#if canImport(EventKit)
import EventKit
import Foundation
import HimawariCore

public final class CalendarActions: DeviceActionHandler, @unchecked Sendable {
    public let names = ["calendar.create", "calendar.delete", "calendar.update"]
    private let store: EKEventStore
    public let permission: DevicePermission

    public init(store: EKEventStore) {
        self.store = store
        permission = CalendarPermission(entity: .event)
    }

    static let attendees = line("日程的参与者", "event invitees", "予定の参加者")

    public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? {
        guard delivery.action != "calendar.create" else { return [:] }
        return try event(delivery).map { event in
            var before = Self.describe(event)
            if before["location"] == nil { before["location"] = .string("") }
            if before["notes"] == nil { before["notes"] = .string("") }
            return before
        }
    }

    public func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        let args = delivery.args
        if let invited = try args.optionalStrings("attendees"), !invited.isEmpty {
            throw DeviceActionFailure(.cannotChange(Self.attendees))
        }
        switch delivery.action {
        case "calendar.create":
            let event = EKEvent(eventStore: store)
            event.title = try args.string("title")
            event.startDate = try args.localDate("start")
            event.endDate = try args.localDate("end")
            event.isAllDay = try args.optionalBool("allDay") ?? false
            event.location = try args.optionalString("location")
            event.notes = try args.optionalString("notes")
            event.calendar = try calendar(named: try args.optionalString("calendar"))
            try store.save(event, span: .thisEvent, commit: true)
            return Self.describe(event)
        case "calendar.update":
            guard let event = try event(delivery) else { throw DeviceActionFailure(.targetMissing) }
            if let title = try args.optionalString("title") { event.title = title }
            if let start = try args.optionalLocalDate("start") { event.startDate = start }
            if let end = try args.optionalLocalDate("end") { event.endDate = end }
            if let location = try args.optionalString("location") { event.location = location }
            if let notes = try args.optionalString("notes") { event.notes = notes }
            try store.save(event, span: .thisEvent, commit: true)
            return Self.describe(event)
        case "calendar.delete":
            guard let event = try event(delivery) else { throw DeviceActionFailure(.targetMissing) }
            let gone = Self.describe(event)
            try store.remove(event, span: .thisEvent, commit: true)
            return gone
        default:
            throw DeviceActionFailure(.notSupported)
        }
    }

    public func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading {
        store.refreshSourcesIfNecessary()
        let args = delivery.args
        switch delivery.action {
        case "calendar.delete":
            if try event(delivery) == nil { return .matches(["absent": .bool(true)]) }
            return .differs(["absent": .bool(false)])
        case "calendar.create":
            let found = try made?["eventId"]?.string.flatMap { store.event(withIdentifier: $0) } ?? search(args)
            guard let found else { return made == nil ? .unreadable : .differs(["absent": .bool(true)]) }
            return try Self.compare(found, args)
        default:
            let id = CalendarOccurrenceId.split(try args.string("eventId")).eventIdentifier
            let moved = try args.optionalLocalDate("start").flatMap { start in
                store.events(matching: store.predicateForEvents(withStart: start.addingTimeInterval(-60), end: start.addingTimeInterval(60), calendars: nil))
                    .first { $0.eventIdentifier == id }
            }
            guard let found = try moved ?? event(delivery) else { return .differs(["absent": .bool(true)]) }
            return try Self.compare(found, args)
        }
    }

    private func event(_ delivery: DeviceActionDelivery) throws -> EKEvent? {
        let parts = CalendarOccurrenceId.split(try delivery.args.string("eventId"))
        let id = parts.eventIdentifier
        guard let occurrence = try delivery.args.optionalLocalDate("occurrenceStart") ?? parts.start else {
            return store.event(withIdentifier: id)
        }
        let predicate = store.predicateForEvents(withStart: occurrence.addingTimeInterval(-60), end: occurrence.addingTimeInterval(60), calendars: nil)
        return store.events(matching: predicate).first { $0.eventIdentifier == id && abs($0.startDate.timeIntervalSince(occurrence)) < 60 }
    }

    private func calendar(named name: String?) throws -> EKCalendar {
        let writable = store.calendars(for: .event).filter(\.allowsContentModifications)
        if let name {
            guard let match = writable.first(where: { $0.title == name }) else { throw DeviceActionFailure(.targetMissing) }
            return match
        }
        guard let fallback = store.defaultCalendarForNewEvents ?? writable.first else { throw DeviceActionFailure(.targetMissing) }
        return fallback
    }

    private func search(_ args: DeviceActionArguments) throws -> EKEvent? {
        let start = try args.localDate("start")
        let end = try args.localDate("end")
        let title = try args.string("title")
        let predicate = store.predicateForEvents(withStart: start.addingTimeInterval(-60), end: end.addingTimeInterval(60), calendars: nil)
        return store.events(matching: predicate).first { $0.title == title && abs($0.startDate.timeIntervalSince(start)) < 60 }
    }

    static func describe(_ event: EKEvent) -> JSONObject {
        var value: JSONObject = [
            "eventId": .string(event.eventIdentifier ?? ""),
            "title": .string(event.title ?? ""),
            "start": .string(DeviceActionTime.localText(event.startDate)),
            "end": .string(DeviceActionTime.localText(event.endDate)),
            "allDay": .bool(event.isAllDay),
            "calendar": .string(event.calendar?.title ?? ""),
        ]
        if let location = event.location { value["location"] = .string(location) }
        if let notes = event.notes { value["notes"] = .string(notes) }
        return value
    }

    static func compare(_ event: EKEvent, _ args: DeviceActionArguments) throws -> DeviceActionReading {
        let found = describe(event)
        for key in ["title", "location", "notes", "start", "end"] {
            guard let wanted = try args.optionalString(key) else { continue }
            if key == "start" || key == "end" {
                guard let date = DeviceActionTime.localDate(wanted) else { throw DeviceActionFailure(.badArguments) }
                if found[key]?.string != DeviceActionTime.localText(date) { return .differs(found) }
            } else if found[key]?.string != wanted {
                return .differs(found)
            }
        }
        return .matches(found)
    }
}
#endif
