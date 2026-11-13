import Foundation

public struct StreamingReply: Sendable, Equatable {
    public let runId: String
    private var pieces: [String: [Int: String]] = [:]
    private var order: [String] = []

    public init(runId: String) {
        self.runId = runId
    }

    public mutating func apply(_ chunk: ExecutionText) {
        guard chunk.runId == runId else { return }
        if pieces[chunk.itemId] == nil { order.append(chunk.itemId) }
        pieces[chunk.itemId, default: [:]][chunk.offset] = chunk.text
    }

    public var text: String {
        order.map { item in
            let parts = pieces[item] ?? [:]
            var assembled = ""
            for offset in parts.keys.sorted() {
                guard let piece = parts[offset] else { continue }
                let current = assembled.utf16.count
                if offset == current {
                    assembled += piece
                } else if offset < current {
                    let overlap = current - offset
                    let units = Array(piece.utf16)
                    if units.count > overlap { assembled += String(decoding: units[overlap...], as: UTF16.self) }
                } else {
                    break
                }
            }
            return assembled
        }
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")
    }
}
