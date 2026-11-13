import Foundation
import HimawariCore

enum L {
    static func text(_ key: String) -> String {
        Bundle.module.localizedString(forKey: key, value: nil, table: nil)
    }
}

public enum HandoverLink {
    public static let scheme = "himawari"
    public static let host = "handover"

    public static func url(_ entry: HandoverEntry) -> URL {
        URL(string: "\(scheme)://\(host)/\(entry.rawValue)")!
    }

    public static let home = URL(string: "\(scheme)://")!

    public static func entry(in url: URL) -> HandoverEntry? {
        guard url.scheme == scheme, url.host == host else { return nil }
        return HandoverEntry(rawValue: url.lastPathComponent)
    }
}
