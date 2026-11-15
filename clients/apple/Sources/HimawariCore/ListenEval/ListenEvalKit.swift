import Foundation

public enum ListenEvalPurpose: String, Codable, Sendable, CaseIterable {
    case enrollment
    case speaker
    case command
    case mixed
    case bystander
    case tvMention = "tv_mention"
    case ownerMention = "owner_mention"
    case publicSpeech = "public_speech"
}

public enum ListenEvalPlacement: String, Codable, Sendable, CaseIterable {
    case hand
    case airpods
    case table
    case pocket
}

public enum ListenEvalCondition: String, Codable, Sendable, CaseIterable {
    case quiet
    case noisy
    case everyday
}

public struct ListenEvalLine: Codable, Sendable, Equatable {
    public let language: String
    public let text: String

    public init(language: String, text: String) {
        self.language = language
        self.text = text
    }
}

public struct ListenEvalPrompt: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let language: String
    public let text: String

    public init(id: String, language: String, text: String) {
        self.id = id
        self.language = language
        self.text = text
    }
}

public struct ListenEvalStage: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let purpose: ListenEvalPurpose
    public let placement: ListenEvalPlacement
    public let condition: ListenEvalCondition
    public let setup: String
    public let prompts: [ListenEvalPrompt]

    public init(id: String, purpose: ListenEvalPurpose, placement: ListenEvalPlacement, condition: ListenEvalCondition, setup: String, prompts: [ListenEvalPrompt]) {
        self.id = id
        self.purpose = purpose
        self.placement = placement
        self.condition = condition
        self.setup = setup
        self.prompts = prompts
    }
}

public struct ListenEvalKit: Codable, Sendable, Equatable {
    public struct Synthetic: Codable, Sendable, Equatable {
        public let bystander: [ListenEvalLine]
        public let tvMention: [ListenEvalLine]

        public init(bystander: [ListenEvalLine], tvMention: [ListenEvalLine]) {
            self.bystander = bystander
            self.tvMention = tvMention
        }
    }

    public let version: Int
    public let stages: [ListenEvalStage]
    public let synthetic: Synthetic

    public init(version: Int, stages: [ListenEvalStage], synthetic: Synthetic) {
        self.version = version
        self.stages = stages
        self.synthetic = synthetic
    }

    public static func decode(_ data: Data) throws -> ListenEvalKit {
        try JSONDecoder().decode(ListenEvalKit.self, from: data)
    }

    public var promptCount: Int {
        stages.reduce(0) { $0 + $1.prompts.count }
    }

    public func stage(containing promptId: String) -> ListenEvalStage? {
        stages.first { stage in stage.prompts.contains { $0.id == promptId } }
    }
}

public struct ListenEvalRecording: Codable, Sendable, Equatable {
    public let promptId: String
    public let file: String
    public let route: AudioInputRoute
    public let inEar: Bool?
    public let recordedAt: Date
    public let seconds: Double

    public init(promptId: String, file: String, route: AudioInputRoute, inEar: Bool?, recordedAt: Date, seconds: Double) {
        self.promptId = promptId
        self.file = file
        self.route = route
        self.inEar = inEar
        self.recordedAt = recordedAt
        self.seconds = seconds
    }
}

public struct ListenEvalSession: Codable, Sendable, Equatable {
    public static let manifestName = "manifest.json"

    public let kitVersion: Int
    public let device: String
    public let system: String
    public private(set) var recordings: [ListenEvalRecording]

    public init(kitVersion: Int, device: String, system: String, recordings: [ListenEvalRecording] = []) {
        self.kitVersion = kitVersion
        self.device = device
        self.system = system
        self.recordings = recordings
    }

    public mutating func record(_ recording: ListenEvalRecording) {
        recordings.removeAll { $0.promptId == recording.promptId }
        recordings.append(recording)
    }

    public func recording(for promptId: String) -> ListenEvalRecording? {
        recordings.first { $0.promptId == promptId }
    }

    public func nextPrompt(in kit: ListenEvalKit) -> (stage: ListenEvalStage, prompt: ListenEvalPrompt)? {
        let done = Set(recordings.map(\.promptId))
        for stage in kit.stages {
            if let prompt = stage.prompts.first(where: { !done.contains($0.id) }) { return (stage, prompt) }
        }
        return nil
    }

    public func recordedCount(in stage: ListenEvalStage) -> Int {
        let done = Set(recordings.map(\.promptId))
        return stage.prompts.filter { done.contains($0.id) }.count
    }

    public static func fileName(for promptId: String) -> String {
        "\(promptId).caf"
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(self)
    }

    public static func decode(_ data: Data) throws -> ListenEvalSession {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(ListenEvalSession.self, from: data)
    }
}
