import Foundation
import Observation

public enum MemoryImportSource: String, CaseIterable, Sendable, Identifiable {
    case codex
    case assistant
    case himawari

    public var id: String { rawValue }
}

public struct MemoryImportFile: Sendable, Equatable {
    public let name: String
    public let text: String

    public init(name: String, text: String) {
        self.name = name
        self.text = text
    }
}

public struct MemoryImportItem: Decodable, Sendable, Identifiable, Hashable {
    public let contentRef: String
    public let text: String
    public let from: String
    public let category: String
    public let subCategory: String?
    public let topic: String?
    public let flag: String?
    public let selectable: Bool
    public var checked: Bool

    public var id: String { contentRef }
}

public struct MemoryImportFileState: Decodable, Sendable, Hashable {
    public let name: String
    public let state: String
    public let found: Int
}

@MainActor
@Observable
public final class MemoryImportStore {
    public enum Problem: Equatable, Sendable {
        case tooManyFiles(Int)
        case tooLong(name: String, maximum: Int)
        case nothingFound
        case unreadable
        case failed(String?)
    }

    public enum Phase: Equatable {
        case idle
        case reading
        case preview
        case importing
        case done(Int)
        case problem(Problem)
    }

    struct Preview: Decodable {
        let files: [MemoryImportFileState]
        let found: Int
        let items: [MemoryImportItem]
    }

    public private(set) var phase: Phase = .idle
    public private(set) var source: MemoryImportSource?
    public private(set) var items: [MemoryImportItem] = []
    public private(set) var found = 0
    public private(set) var files: [MemoryImportFileState] = []

    @ObservationIgnored private let gateway: ManageGateway
    @ObservationIgnored private let makeBatchId: @Sendable () -> String

    public init(
        gateway: ManageGateway,
        makeBatchId: @escaping @Sendable () -> String = {
            "memory-import-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
        }
    ) {
        self.gateway = gateway
        self.makeBatchId = makeBatchId
    }

    public var chosen: [MemoryImportItem] { items.filter { $0.selectable && $0.checked } }

    public func reset() {
        phase = .idle
        source = nil
        items = []
        found = 0
        files = []
    }

    public func unreadable(_ source: MemoryImportSource) {
        reset()
        self.source = source
        phase = .problem(.unreadable)
    }

    public func toggle(_ item: MemoryImportItem) {
        guard item.selectable, let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[index].checked.toggle()
    }

    public func preview(_ source: MemoryImportSource, files input: [MemoryImportFile]) async {
        self.source = source
        items = []
        found = 0
        files = []
        let limit = ClientCapabilities.textUploadMaximumCharacters
        guard !input.isEmpty else {
            phase = .problem(.nothingFound)
            return
        }
        guard input.count <= ClientCapabilities.memoryImportFilesMaximum else {
            phase = .problem(.tooManyFiles(ClientCapabilities.memoryImportFilesMaximum))
            return
        }
        if let long = input.first(where: { $0.text.utf16.count > limit }) {
            phase = .problem(.tooLong(name: long.name, maximum: limit))
            return
        }
        phase = .reading
        do {
            var sent: [JSONValue] = []
            for file in input {
                let contentRef = try await gateway.uploadText(file.text)
                sent.append(["name": .string(String(file.name.prefix(ClientCapabilities.memoryImportFileNameMaximum))), "contentRef": .string(contentRef)])
            }
            let data = try await gateway.read(
                .v2,
                "memory.import.preview.read",
                payload: ["source": .string(source.rawValue), "files": .array(sent)]
            )
            let preview = try JSONDecoder().decode(Snapshot<Preview>.self, from: data).payload
            items = preview.items
            found = preview.found
            files = preview.files
            if !preview.items.isEmpty {
                phase = .preview
            } else if preview.files.allSatisfy({ $0.state == "unreadable" }) {
                phase = .problem(.unreadable)
            } else {
                phase = .problem(.nothingFound)
            }
        } catch let ManageGatewayError.rejected(_, code, _) {
            phase = .problem(.failed(code))
        } catch {
            phase = .problem(.failed(nil))
        }
    }

    @discardableResult
    public func commit(reason: String) async -> Bool {
        let picked = chosen
        guard let source, !picked.isEmpty, phase == .preview else { return false }
        phase = .importing
        do {
            _ = try await gateway.command(
                .v2,
                "memory.import.commit",
                payload: [
                    "batchId": .string(makeBatchId()),
                    "source": .string(source.rawValue),
                    "items": .array(picked.map { item -> JSONValue in
                        [
                            "contentRef": .string(item.contentRef),
                            "category": .string(item.category),
                            "subCategory": item.subCategory.map(JSONValue.string) ?? .null,
                            "topic": item.topic.map(JSONValue.string) ?? .null,
                        ]
                    }),
                ],
                options: ManageCommandOptions(risk: "medium", confirmReason: reason)
            )
            phase = .done(picked.count)
            return true
        } catch {
            phase = .preview
            return false
        }
    }
}
