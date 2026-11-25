import Foundation

public struct TalkTurn: Sendable, Equatable {
    public static let quietAfterFinal: Duration = .milliseconds(500)
    public static let quietAfterVolatile: Duration = .milliseconds(1500)

    public private(set) var settled = ""
    public private(set) var pending = ""
    private var lastChange: ContinuousClock.Instant?
    private var endsOnFinal = false

    public init() {}

    public var text: String { settled + pending }

    public var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public mutating func heard(_ piece: String, isFinal: Bool, at now: ContinuousClock.Instant) {
        if isFinal {
            settled += piece
            pending = ""
        } else {
            pending = piece
        }
        endsOnFinal = isFinal
        lastChange = now
    }

    public func isDone(at now: ContinuousClock.Instant) -> Bool {
        guard !isEmpty, let lastChange else { return false }
        let quiet = now - lastChange
        return quiet >= (endsOnFinal ? Self.quietAfterFinal : Self.quietAfterVolatile)
    }

    public mutating func take() -> String {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        self = TalkTurn()
        return said
    }
}

public enum SpokenText {
    static let marks: Set<Character> = ["*", "`", "#", "|", "~", ">"]

    public static func from(markdown: String) -> String {
        String(markdown.filter { !marks.contains($0) })
    }
}
