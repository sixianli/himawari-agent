#if os(iOS)
import EventKit
import Foundation
import HimawariCore

@MainActor
public final class CalendarCollector: SenseCollector {
    public let item = SenseItem.calendar
    public static let lookBack: TimeInterval = 90 * 86_400
    public static let lookAhead: TimeInterval = 365 * 86_400

    private let store = EKEventStore()
    private var sink: SenseSink?
    private var observer: NSObjectProtocol?

    public init() {}

    public func authorization() async -> SenseAuthorization {
        Self.map(EKEventStore.authorizationStatus(for: .event))
    }

    public func requestAuthorization() async -> SenseAuthorization {
        _ = try? await store.requestFullAccessToEvents()
        return Self.map(EKEventStore.authorizationStatus(for: .event))
    }

    public func start(_ sink: SenseSink) {
        self.sink = sink
        observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.sync(forceFull: false) }
        }
        Task { await sync(forceFull: false) }
    }

    public func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        sink = nil
    }

    func sync(forceFull: Bool) async {
        guard let sink, let kind = item.mirrorKind else { return }
        let now = Date()
        let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-Self.lookBack), end: now.addingTimeInterval(Self.lookAhead), calendars: nil)
        let entries = store.events(matching: predicate).map(Self.entry)
        await sink.mirror(kind: kind, entries: entries, forceFull: forceFull)
    }

    static func entry(_ event: EKEvent) -> MirrorEntry {
        var data: [String: JSONScalar] = [
            "title": .string(event.title ?? ""),
            "startsAtMs": SenseRecordBuilder.milliseconds(event.startDate),
            "endsAtMs": SenseRecordBuilder.milliseconds(event.endDate),
            "allDay": .bool(event.isAllDay),
        ]
        if let name = event.calendar?.title { data["calendarName"] = .string(name) }
        if let location = event.location, !location.isEmpty { data["location"] = .string(location) }
        if let notes = event.notes, !notes.isEmpty { data["notes"] = .string(notes) }
        if let attendees = event.attendees { data["attendeeCount"] = .number(Double(attendees.count)) }
        let id = CalendarOccurrenceId.of(eventIdentifier: event.eventIdentifier ?? event.calendarItemIdentifier, start: event.startDate, recurring: event.hasRecurrenceRules)
        return MirrorEntry(externalId: String(id.prefix(256)), data: data)
    }

    static func map(_ status: EKAuthorizationStatus) -> SenseAuthorization {
        switch status {
        case .notDetermined: .notAsked
        case .fullAccess: .allowed
        case .restricted: .restricted
        case .denied, .writeOnly: .denied
        @unknown default: .denied
        }
    }
}
#endif
