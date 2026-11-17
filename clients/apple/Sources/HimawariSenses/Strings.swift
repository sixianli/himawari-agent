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

extension SenseItem {
    func text(_ field: String) -> String {
        L.text("item.\(rawValue).\(field)")
    }

    var name: String { text("name") }
}
