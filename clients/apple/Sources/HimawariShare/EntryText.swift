import HimawariCore

extension HandoverEntry {
    public var title: String { L.text("entry.\(rawValue).title") }

    public var detail: String { L.text("entry.\(rawValue).detail") }
}
