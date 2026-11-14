import Foundation

public enum DayDistance: Equatable, Sendable {
    case sameDay
    case yesterday
    case withinWeek
    case older

    public static func between(_ date: Date, and now: Date, calendar: Calendar) -> DayDistance {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? Int.max
        switch days {
        case 0: return .sameDay
        case 1: return .yesterday
        case ..<7: return .withinWeek
        default: return .older
        }
    }
}
