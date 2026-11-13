import Foundation
import Testing
@testable import HimawariCore

@Suite struct DayDistanceTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }()

    private func day(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    @Test func yesterdayFollowsTheGivenNowNotTheRealClock() {
        let now = day(2020, 3, 10, 9)
        #expect(DayDistance.between(day(2020, 3, 10, 1), and: now, calendar: calendar) == .sameDay)
        #expect(DayDistance.between(day(2020, 3, 9, 23), and: now, calendar: calendar) == .yesterday)
        #expect(DayDistance.between(day(2020, 3, 4), and: now, calendar: calendar) == .withinWeek)
        #expect(DayDistance.between(day(2020, 3, 3), and: now, calendar: calendar) == .older)
        #expect(DayDistance.between(Date(), and: now, calendar: calendar) != .yesterday)
        #expect(DayDistance.between(Date().addingTimeInterval(-86_400), and: Date(), calendar: calendar) == .yesterday)
    }
}
