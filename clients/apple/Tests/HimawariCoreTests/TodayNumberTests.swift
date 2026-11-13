import Foundation
import HimawariCore
import Testing

struct TodayNumberTests {
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!
    private let newYork = TimeZone(identifier: "America/New_York")!

    private func date(_ text: String) -> Date {
        try! Date(text, strategy: .iso8601)
    }

    @Test func showsTheDayOfMonthInTheDeviceTimeZone() {
        #expect(TodayNumber.day(at: date("2026-11-12T06:00:00Z"), in: tokyo) == 12)
        #expect(TodayNumber.day(at: date("2026-11-09T06:00:00Z"), in: tokyo) == 9)
        #expect(TodayNumber.day(at: date("2026-12-31T06:00:00Z"), in: tokyo) == 31)
    }

    @Test func changesAtLocalMidnight() {
        #expect(TodayNumber.day(at: date("2026-11-12T14:59:59Z"), in: tokyo) == 12)
        #expect(TodayNumber.day(at: date("2026-11-12T15:00:00Z"), in: tokyo) == 13)
        #expect(TodayNumber.day(at: date("2026-11-30T15:00:00Z"), in: tokyo) == 1)
    }

    @Test func followsATimeZoneChange() {
        let instant = date("2026-11-12T20:00:00Z")
        #expect(TodayNumber.day(at: instant, in: tokyo) == 13)
        #expect(TodayNumber.day(at: instant, in: newYork) == 12)
    }
}
