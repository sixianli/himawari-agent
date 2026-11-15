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

enum DeviceActionsText {
    static var changed: String { L.text("actions.changed") }
    static var notSent: String { L.text("actions.notSent") }
    static var needsFace: String { L.text("actions.needsFace") }
    static var policyReason: String { L.text("actions.policyReason") }
}
