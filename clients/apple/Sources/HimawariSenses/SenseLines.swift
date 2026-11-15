import Foundation
import HimawariCore

struct SenseLine: Identifiable, Equatable {
    let id: String
    let at: Date
    let title: String
    let record: PerceptionRecordView
}

enum SenseLines {
    static func lines(_ day: PerceptionDaySnapshot) -> [SenseLine] {
        let records = day.rows.compactMap(\.record)
        var visits: [String: PerceptionRecordView] = [:]
        var others: [PerceptionRecordView] = []
        for record in records {
            guard record.type == "location.visit", let arrived = record.value("arrivedAtMs") else {
                others.append(record)
                continue
            }
            if let kept = visits[arrived], kept.value("departedAtMs") != nil { continue }
            visits[arrived] = record
        }
        return (Array(visits.values) + others)
            .compactMap { record in
                guard let at = date(record) else { return nil }
                return SenseLine(id: record.id, at: at, title: title(record), record: record)
            }
            .sorted { $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at }
    }

    static func date(_ record: PerceptionRecordView) -> Date? {
        if record.type == "location.visit", let arrived = record.number("arrivedAtMs") {
            return Date(timeIntervalSince1970: arrived / 1000)
        }
        return parse(record.occurredAt)
    }

    static func parse(_ text: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static func title(_ record: PerceptionRecordView) -> String {
        switch record.type {
        case "location.visit":
            let place = record.value("placeName") ?? L.text("row.place")
            var title = L.format("row.arrived", place)
            if let arrived = record.number("arrivedAtMs"), let departed = record.number("departedAtMs"), departed > arrived {
                title += L.format("row.stayed", duration((departed - arrived) / 1000))
            }
            return title
        case "location.region":
            let place = record.value("regionId") ?? L.text("row.place")
            return L.format(record.value("transition") == "exit" ? "row.left" : "row.entered", place)
        case "health.sample":
            return health(record)
        case "motion.activity":
            return L.text("row.activity.\(record.value("activity") ?? "stationary")")
        case "photo.asset":
            return L.text("row.photo")
        case "photo.screenshot":
            return L.text("row.screenshot")
        case "clipboard.item":
            return L.format("row.clipboard", record.text ?? "")
        default:
            return record.text ?? record.type
        }
    }

    static func health(_ record: PerceptionRecordView) -> String {
        let value = record.number("value") ?? 0
        switch record.value("subtype") {
        case "steps": return L.format("row.steps", value.formatted(.number.precision(.fractionLength(0))))
        case "sleep": return L.format("row.sleep", duration(value * 60))
        case "heart_rate": return L.format("row.heartRate", value.formatted(.number.precision(.fractionLength(0))))
        default: return L.format("row.workout", duration(value * 60))
        }
    }

    static func duration(_ seconds: Double) -> String {
        let minutes = max(Int((seconds / 60).rounded()), 1)
        let hours = minutes / 60
        let rest = minutes % 60
        if hours == 0 { return L.format("duration.m", rest) }
        if rest == 0 { return L.format("duration.h", hours) }
        return L.format("duration.hm", hours, rest)
    }

    static func time(_ date: Date) -> String {
        date.formatted(.dateTime.hour(.defaultDigits(amPM: .omitted)).minute(.twoDigits))
    }
}
