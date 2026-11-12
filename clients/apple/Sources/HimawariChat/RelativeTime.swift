import Foundation

enum RelativeTime {
    static let parser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func date(_ text: String) -> Date? {
        parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static func label(_ text: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = date(text) else { return "" }
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) {
            return L.text("time.yesterday")
        }
        if let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day, days < 7 {
            return date.formatted(.dateTime.weekday(.abbreviated))
        }
        return date.formatted(.dateTime.month(.defaultDigits).day())
    }
}
