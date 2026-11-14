import Foundation

public struct ServerSentEvent: Sendable, Equatable {
    public let event: String
    public let data: String
    public let id: String?

    public init(event: String, data: String, id: String?) {
        self.event = event
        self.data = data
        self.id = id
    }
}

public struct ServerSentEventParser: Sendable {
    private var buffer = ""
    private var eventName = ""
    private var dataLines: [String] = []
    private var eventId: String?
    private var sawField = false

    public init() {}

    public mutating func feed(_ chunk: String) -> [ServerSentEvent] {
        buffer += chunk
        var events: [ServerSentEvent] = []
        var scalars = buffer.unicodeScalars[...]
        while let end = scalars.firstIndex(where: { $0 == "\n" || $0 == "\r" }) {
            var rest = scalars.index(after: end)
            if scalars[end] == "\r" {
                if rest == scalars.endIndex { break }
                if scalars[rest] == "\n" { rest = scalars.index(after: rest) }
            }
            let line = String(scalars[..<end])
            scalars = scalars[rest...]
            if let event = consume(line: line) { events.append(event) }
        }
        buffer = String(scalars)
        return events
    }

    public mutating func consume(line: String) -> ServerSentEvent? {
        if line.isEmpty {
            defer {
                eventName = ""
                dataLines = []
                eventId = nil
                sawField = false
            }
            guard sawField else { return nil }
            return ServerSentEvent(
                event: eventName.isEmpty ? "message" : eventName,
                data: dataLines.joined(separator: "\n"),
                id: eventId
            )
        }
        if line.hasPrefix(":") { return nil }
        let field: String
        var value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[line.startIndex..<colon])
            value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = line
            value = ""
        }
        switch field {
        case "event":
            eventName = value
            sawField = true
        case "data":
            dataLines.append(value)
            sawField = true
        case "id":
            if !value.contains("\u{0}") { eventId = value }
            sawField = true
        default:
            break
        }
        return nil
    }
}
