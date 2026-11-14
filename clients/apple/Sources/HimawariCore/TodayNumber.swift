import Foundation

public enum TodayNumber {
    public static func day(at date: Date, in timeZone: TimeZone = .autoupdatingCurrent) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.component(.day, from: date)
    }
}
