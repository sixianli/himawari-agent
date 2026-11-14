import Foundation
import HimawariCore

@MainActor
public enum SafariBridge {
    public static let wordKeys = [
        "sheet.title", "sheet.close", "sheet.placeholder", "sheet.note.page", "sheet.note.urlOnly", "sheet.fullPage",
        "sheet.textUnreadable", "sheet.send", "sheet.sendUrl", "sheet.sending",
    ]

    public static func reply(
        to message: [String: Any],
        desk: HandoverDesk?,
        now: () -> Date = Date.init,
        locale: AnswerLocale = AnswerLocale.matching(preferredLanguages: Locale.preferredLanguages)
    ) async -> [String: Any] {
        guard message["kind"] as? String == "hand" else {
            var reply = describe(desk == nil ? .unpaired : .editing)
            reply["words"] = Dictionary(uniqueKeysWithValues: wordKeys.map { ($0, L.text($0)) })
            return reply
        }
        guard let desk else { return describe(.unpaired) }
        guard let content = (message["page"] as? [String: Any]).flatMap(HandoverContent.page(from:)) else { return describe(.unreadable) }
        let handover = Handover(
            entry: .safari,
            content: content,
            request: message["request"] as? String,
            sourceApp: nil,
            createdAt: now(),
            answerLocale: locale
        )
        return describe(.finished(await desk.hand(handover)))
    }

    static func describe(_ phase: HandoverSheetPhase) -> [String: Any] {
        var reply: [String: Any] = ["phase": name(phase), "done": phase.isDone]
        if case let .finished(outcome) = phase { reply["kept"] = outcome.keepsWhatWasRead }
        if let line = phase.line { reply["line"] = line }
        if let title = phase.followUpTitle, let url = phase.followUpURL(.safari) {
            reply["button"] = title
            reply["link"] = url.absoluteString
        }
        if phase.closesItself {
            let delay = HandoverSheetPhase.closeDelay.components
            reply["closeAfterMs"] = Int(delay.seconds * 1000 + delay.attoseconds / 1_000_000_000_000_000)
        }
        return reply
    }

    static func name(_ phase: HandoverSheetPhase) -> String {
        switch phase {
        case .editing: "editing"
        case .sending: "sending"
        case .finished: "finished"
        case .unpaired: "unpaired"
        case .unreadable: "unreadable"
        }
    }
}
