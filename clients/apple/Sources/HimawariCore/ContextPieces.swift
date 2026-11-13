import Foundation

public enum ContextPieceSource: String, Codable, Sendable, Equatable {
    case frontApp
    case document
    case selection
    case droppedFile
}

public struct ContextPiece: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let source: ContextPieceSource
    public let name: String
    public let content: String
    public let kind: AttachmentKind
    public let bytes: Int?
    public let fileURL: URL?

    public init(id: String = OutgoingMessage.newId(), source: ContextPieceSource, name: String, content: String, kind: AttachmentKind = .text, bytes: Int? = nil, fileURL: URL? = nil) {
        self.id = id
        self.source = source
        self.name = MessageAttachments.cleanName(name)
        self.content = content
        self.kind = kind
        self.bytes = bytes
        self.fileURL = fileURL
    }
}

public struct FrontApp: Sendable, Equatable {
    public let name: String
    public let bundleId: String?

    public init(name: String, bundleId: String?) {
        self.name = name
        self.bundleId = bundleId
    }
}

public struct ContextSnapshot: Sendable, Equatable {
    public var frontApp: FrontApp?
    public var document: URL?
    public var selection: String?

    public init(frontApp: FrontApp? = nil, document: URL? = nil, selection: String? = nil) {
        self.frontApp = frontApp
        self.document = document
        self.selection = selection
    }
}

public struct ContextLabels: Sendable {
    public let frontApp: @Sendable (FrontApp) -> String
    public let selection: @Sendable (Int) -> String

    public init(frontApp: @escaping @Sendable (FrontApp) -> String, selection: @escaping @Sendable (Int) -> String) {
        self.frontApp = frontApp
        self.selection = selection
    }
}

public enum ContextGathering {
    public static func pieces(
        from snapshot: ContextSnapshot,
        seesFrontmost: Bool,
        labels: ContextLabels,
        readFile: (URL) -> FileReading
    ) -> [ContextPiece] {
        var pieces: [ContextPiece] = []
        if seesFrontmost, let app = snapshot.frontApp {
            let content = app.bundleId.map { "\(app.name) (\($0))" } ?? app.name
            pieces.append(ContextPiece(source: .frontApp, name: labels.frontApp(app), content: content))
        }
        if seesFrontmost, let document = snapshot.document, document.isFileURL {
            pieces.append(filePiece(document, source: .document, reading: readFile(document)))
        }
        if let selection = snapshot.selection?.trimmingCharacters(in: .whitespacesAndNewlines), !selection.isEmpty {
            pieces.append(ContextPiece(source: .selection, name: labels.selection(lineCount(selection)), content: selection))
        }
        return pieces
    }

    public static func filePiece(_ url: URL, source: ContextPieceSource, reading: FileReading) -> ContextPiece {
        let name = url.lastPathComponent
        switch reading {
        case let .text(text, kind, bytes):
            return ContextPiece(source: source, name: name, content: text, kind: kind, bytes: bytes, fileURL: url)
        case let .unreadable(bytes):
            return ContextPiece(source: source, name: name, content: url.path, kind: .text, bytes: bytes, fileURL: url)
        }
    }

    public static func lineCount(_ text: String) -> Int {
        text.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count
    }

    public static func merge(_ current: [ContextPiece], adding new: [ContextPiece]) -> [ContextPiece] {
        merge(current, adding: new, limit: nil).pieces
    }

    public static func merge(_ current: [ContextPiece], adding new: [ContextPiece], limit: Int?) -> (pieces: [ContextPiece], overflowed: Bool) {
        var result = current
        var overflowed = false
        for piece in new where !result.contains(where: { $0.fileURL != nil && $0.fileURL == piece.fileURL }) {
            if let limit, result.count >= limit {
                overflowed = true
                continue
            }
            result.append(piece)
        }
        return (result, overflowed)
    }
}

public enum FileReading: Sendable, Equatable {
    case text(String, kind: AttachmentKind, bytes: Int)
    case unreadable(bytes: Int?)
}

public enum PlainTextFile {
    public static let readLimitBytes = 8 * 1024 * 1024

    public static func read(_ url: URL) -> FileReading {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        let size = values?.fileSize
        guard values?.isRegularFile == true, let size, size <= readLimitBytes,
              let data = try? Data(contentsOf: url, options: .mappedIfSafe)
        else { return .unreadable(bytes: size) }
        guard !data.contains(0), let text = String(data: data, encoding: .utf8) else { return .unreadable(bytes: size) }
        return .text(text, kind: .text, bytes: size)
    }
}
