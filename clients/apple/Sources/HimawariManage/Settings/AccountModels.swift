import Foundation

public struct LoginDevice: Decodable, Sendable, Identifiable, Hashable {
    public let deviceId: String
    public let label: String
    public let firstSeenAt: String
    public let lastSeenAt: String
    public let current: Bool

    public var id: String { deviceId }
}

public enum SignOutOthersOutcome: Equatable, Sendable {
    case done
    case stillChanging
}

struct LoginDevicesPayload: Decodable {
    let devices: [LoginDevice]
}

public struct StoredFile: Decodable, Sendable, Identifiable, Hashable {
    public let fileId: String
    public let threadId: String
    public let threadTitle: String?
    public let name: String
    public let kind: String
    public let origin: String
    public let mediaType: String
    public let sizeBytes: Int
    public let version: Int
    public let createdAt: String
    public let deleted: Bool
    public let contentPath: String?

    public var id: String { fileId }
}

struct FilesPage: Decodable {
    let files: [StoredFile]
    let nextCursor: String?
}

public enum FileOrigin: String, CaseIterable, Sendable, Hashable {
    case generated
    case uploaded
}

public struct FileShelf: Equatable, Sendable {
    public var files: [StoredFile] = []
    public var nextCursor: String?
    public var loaded = false
    public var failed = false
}
