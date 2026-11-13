import Foundation
import HimawariCore

enum RelativeTime {
    static func date(_ text: String) -> Date? {
        (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: Date.ISO8601FormatStyle()))
    }

    static func label(_ text: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = date(text) else { return "" }
        switch DayDistance.between(date, and: now, calendar: calendar) {
        case .sameDay:
            return date.formatted(date: .omitted, time: .shortened)
        case .yesterday:
            return L.text("time.yesterday")
        case .withinWeek:
            return date.formatted(.dateTime.weekday(.abbreviated))
        case .older:
            break
        }
        return date.formatted(.dateTime.month(.defaultDigits).day())
    }
}
