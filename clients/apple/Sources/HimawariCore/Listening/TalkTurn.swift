import Foundation

public struct TalkTurn: Sendable, Equatable {
    public static let quietAfterFinal: Duration = .milliseconds(500)
    public static let quietAfterVolatile: Duration = .milliseconds(1500)

    public private(set) var settled = ""
    public private(set) var pending = ""
    private var lastChange: ContinuousClock.Instant?
    private var endsOnFinal = false
    private var heardUntil: TimeInterval?
    private var sentUntil: TimeInterval?
    private var sentWordCount = 0
    private var continuesLastSend = false

    public init() {}

    public var text: String { settled + pending }

    public var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    public mutating func heard(_ piece: String, isFinal: Bool, from start: TimeInterval, to end: TimeInterval, at now: ContinuousClock.Instant) {
        var piece = piece
        if let sentUntil, start < sentUntil {
            piece = Self.dropping(sentWordCount, wordCharactersFrom: piece)
            guard !piece.isEmpty else { return }
            continuesLastSend = true
        }
        if isFinal {
            settled += piece
            pending = ""
        } else {
            pending = piece
        }
        endsOnFinal = isFinal
        lastChange = now
        heardUntil = max(heardUntil ?? end, end)
    }

    public func isDone(at now: ContinuousClock.Instant) -> Bool {
        guard !isEmpty, let lastChange else { return false }
        let quiet = now - lastChange
        return quiet >= (endsOnFinal ? Self.quietAfterFinal : Self.quietAfterVolatile)
    }

    public mutating func take() -> String {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        forget(said)
        return said
    }

    public mutating func drop() {
        forget(text)
    }

    private mutating func forget(_ said: String) {
        let until = [sentUntil, heardUntil].compactMap { $0 }.max()
        let count = (continuesLastSend ? sentWordCount : 0) + Self.wordCharacters(in: said)
        self = TalkTurn()
        sentUntil = until
        sentWordCount = count
    }

    static func wordCharacters(in text: String) -> Int {
        text.filter { $0.isLetter || $0.isNumber }.count
    }

    static func dropping(_ count: Int, wordCharactersFrom text: String) -> String {
        var seen = 0
        var index = text.startIndex
        while index < text.endIndex, seen < count {
            if text[index].isLetter || text[index].isNumber { seen += 1 }
            index = text.index(after: index)
        }
        let rest = text[index...].drop { !($0.isLetter || $0.isNumber) }
        return String(rest)
    }
}

public enum SpokenText {
    static let marks: Set<Character> = ["*", "`", "#", "|", "~", ">"]

    public static func from(markdown: String) -> String {
        String(markdown.filter { !marks.contains($0) })
    }
}
