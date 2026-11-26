import Foundation

public enum BubbleSpeaker: Sendable, Equatable {
    case her
    case owner
    case other
}

public struct BubbleEntry: Sendable, Equatable {
    public let id: String
    public let speaker: BubbleSpeaker?
    public let at: Date?

    public init(id: String, speaker: BubbleSpeaker?, at: Date?) {
        self.id = id
        self.speaker = speaker
        self.at = at
    }

    public static func step(id: String) -> BubbleEntry {
        BubbleEntry(id: id, speaker: nil, at: nil)
    }
}

public enum BubbleGap: Sendable, Equatable {
    case none
    case inGroup
    case newSpeaker
    case aroundStep
}

public struct BubblePlacement: Sendable, Equatable {
    public let timeAbove: Date?
    public let gapAbove: BubbleGap
    public let tail: Bool

    public init(timeAbove: Date?, gapAbove: BubbleGap, tail: Bool) {
        self.timeAbove = timeAbove
        self.gapAbove = gapAbove
        self.tail = tail
    }
}

public enum BubbleLayout {
    public static let timeGap: TimeInterval = 15 * 60

    public static func place(_ entries: [BubbleEntry]) -> [String: BubblePlacement] {
        let times = separators(entries)
        var placements: [String: BubblePlacement] = [:]
        var lastSpeaker: BubbleSpeaker?
        for (index, entry) in entries.enumerated() {
            let gap: BubbleGap
            if index == 0 {
                gap = .none
            } else if times[index] != nil {
                gap = .newSpeaker
            } else if entry.speaker == nil {
                gap = lastSpeaker == .her ? .aroundStep : .newSpeaker
            } else if entries[index - 1].speaker == nil {
                gap = .aroundStep
            } else {
                gap = entry.speaker == lastSpeaker ? .inGroup : .newSpeaker
            }
            var tail = false
            if let speaker = entry.speaker {
                if let next = nextMessage(after: index, in: entries) {
                    tail = entries[next].speaker != speaker || (index + 1...next).contains { times[$0] != nil }
                } else {
                    tail = true
                }
                lastSpeaker = speaker
            }
            placements[entry.id] = BubblePlacement(timeAbove: times[index], gapAbove: gap, tail: tail)
        }
        return placements
    }

    static func separators(_ entries: [BubbleEntry]) -> [Date?] {
        var times: [Date?] = Array(repeating: nil, count: entries.count)
        var previousAt: Date?
        for (index, entry) in entries.enumerated() {
            guard entry.speaker != nil, let at = entry.at else { continue }
            if let previousAt, at.timeIntervalSince(previousAt) >= timeGap {
                var anchor = index
                while anchor > 0, entries[anchor - 1].speaker == nil { anchor -= 1 }
                times[anchor] = at
            }
            previousAt = at
        }
        return times
    }

    private static func nextMessage(after index: Int, in entries: [BubbleEntry]) -> Int? {
        entries.indices.first { $0 > index && entries[$0].speaker != nil }
    }
}
