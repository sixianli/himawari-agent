import Foundation
import HimawariCore

enum L {
    static func text(_ key: String) -> String {
        Bundle.module.localizedString(forKey: key, value: nil, table: nil)
    }

    static func format(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: text(key), locale: Locale.current, arguments: arguments)
    }
}

public enum ListenText {
    public static func source(_ route: AudioInputRoute) -> String {
        L.text("source.\(route.rawValue)")
    }

    public static func elapsed(_ seconds: TimeInterval) -> String {
        let minutes = max(0, Int(seconds / 60))
        if minutes < 60 { return L.format("elapsed.minutes", minutes) }
        return L.format("elapsed.hours", minutes / 60, minutes % 60)
    }

    public static func askExplanation(heard: String, reason: SpokenCommandRefusal) -> String {
        L.format("ask.heard", heard, L.text("ask.reason.\(reason.rawValue)"))
    }
    public static var nowLabel: String { L.text("notice.now") }
    public static var demoRequest: String { L.text("demo.request") }
    public static var demoRequestTail: String { L.text("demo.requestTail") }
    public static var demoAskHeard: String { L.text("demo.askHeard") }
    public static var askQuestion: String { L.text("speech.ask") }
    public static var callingReply: String { L.text("speech.calling") }

    public static func enrollmentPrompts() -> [String] {
        (1...3).map { L.text("enroll.prompt.\($0)") }
    }

    public static func resumeMoment(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened))
        return calendar.isDate(date, inSameDayAs: now) ? L.format("resume.today", time) : L.format("resume.tomorrow", time)
    }
}

public struct ListenNoticeText: Sendable, Equatable {
    public let title: String
    public let body: String

    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }

    public static func of(_ notice: ListeningNotice, policy: ListeningPolicy, now: Date) -> ListenNoticeText {
        switch notice {
        case .pausedTapToContinue:
            ListenNoticeText(title: L.text("notice.paused.title"), body: L.text("notice.paused.body"))
        case let .stopped(.dailyAudioLimit, resumesAt):
            ListenNoticeText(
                title: L.text("notice.audioLimit.title"),
                body: L.format("notice.audioLimit.body", ListenText.resumeMoment(resumesAt ?? now, now: now))
            )
        case .stopped(.senseOff, _):
            ListenNoticeText(title: L.text("notice.senseOff.title"), body: L.text("notice.senseOff.body"))
        case .stopped(.paused, _):
            ListenNoticeText(title: L.text("notice.pausedServer.title"), body: L.text("notice.pausedServer.body"))
        case .stopped(.owner, _):
            ListenNoticeText(title: L.text("notice.pauseHourEnded.title"), body: L.text("notice.pauseHourEnded.body"))
        case .downgraded(.batteryLow):
            ListenNoticeText(title: L.format("notice.downgraded.batteryLow.title", policy.batteryFloorPercent), body: L.text("notice.downgraded.body"))
        case .downgraded(.deviceHot):
            ListenNoticeText(title: L.text("notice.downgraded.deviceHot.title"), body: L.text("notice.downgraded.body"))
        case .downgraded(.batteryBudget):
            ListenNoticeText(title: L.text("notice.downgraded.batteryBudget.title"), body: L.text("notice.downgraded.batteryBudget.body"))
        case .restored:
            ListenNoticeText(title: L.text("notice.restored.title"), body: "")
        }
    }

    public static var pauseHourEnded: ListenNoticeText {
        ListenNoticeText(title: L.text("notice.pauseHourEnded.title"), body: L.text("notice.pauseHourEnded.body"))
    }

    public static var continueAction: String { L.text("notice.continue") }
    public static var notMeAction: String { L.text("live.notMe") }
    public static var itsMeAction: String { L.text("live.itsMe") }
    public static var askTitle: String { L.text("live.ask") }
    public static var askOnAirPods: String { L.text("notice.ask.body.airpods") }
}
