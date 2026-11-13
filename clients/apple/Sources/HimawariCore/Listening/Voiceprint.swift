import Foundation

public struct Voiceprint: Codable, Sendable, Equatable {
    public let model: String
    public let vector: [Float]
    public let samples: Int
    public let enrolledAt: Date

    public init?(model: String, samples: [[Float]], enrolledAt: Date) {
        guard let dimensions = samples.first?.count, dimensions > 0, samples.allSatisfy({ $0.count == dimensions }) else { return nil }
        var sum = [Float](repeating: 0, count: dimensions)
        for sample in samples {
            guard let unit = Self.normalized(sample) else { return nil }
            for index in 0..<dimensions { sum[index] += unit[index] }
        }
        guard let mean = Self.normalized(sum) else { return nil }
        self.model = model
        self.vector = mean
        self.samples = samples.count
        self.enrolledAt = enrolledAt
    }

    public func score(_ embedding: [Float], model: String) -> Int? {
        guard model == self.model, embedding.count == vector.count, let unit = Self.normalized(embedding) else { return nil }
        var cosine: Float = 0
        for index in 0..<vector.count { cosine += vector[index] * unit[index] }
        return VoiceScore.fromUnit(Double(max(cosine, 0)))
    }

    static func normalized(_ values: [Float]) -> [Float]? {
        guard values.allSatisfy({ $0.isFinite }) else { return nil }
        let length = values.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
        guard length > 0 else { return nil }
        return values.map { $0 / length }
    }
}

public protocol SpeakerEmbedder: Sendable {
    var model: String { get }
    func embedding(samples: [Float], sampleRate: Double) async throws -> [Float]
}

public struct VoiceprintEnrollment: Sendable, Equatable {
    public let prompts: [String]
    public private(set) var collected: [[Float]] = []

    public init(prompts: [String]) {
        self.prompts = prompts
    }

    public var currentIndex: Int? {
        collected.count < prompts.count ? collected.count : nil
    }

    public var isComplete: Bool { currentIndex == nil }

    public mutating func add(_ embedding: [Float]) {
        guard !isComplete else { return }
        collected.append(embedding)
    }

    public func voiceprint(model: String, at date: Date) -> Voiceprint? {
        isComplete ? Voiceprint(model: model, samples: collected, enrolledAt: date) : nil
    }
}

public protocol VoiceprintStore: Sendable {
    func load() throws -> Voiceprint?
    func save(_ voiceprint: Voiceprint) throws
    func delete() throws
}

public final class FileVoiceprintStore: VoiceprintStore, @unchecked Sendable {
    private let url: URL
    private let lock = NSLock()

    public init(url: URL) {
        self.url = url
    }

    public func load() throws -> Voiceprint? {
        try lock.withLock {
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            return try JSONDecoder().decode(Voiceprint.self, from: Data(contentsOf: url))
        }
    }

    public func save(_ voiceprint: Voiceprint) throws {
        try lock.withLock {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            var options: Data.WritingOptions = [.atomic]
            #if os(iOS) || os(watchOS)
            options.insert(.completeFileProtectionUntilFirstUserAuthentication)
            #endif
            try JSONEncoder().encode(voiceprint).write(to: url, options: options)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var target = url
            try target.setResourceValues(values)
        }
    }

    public func delete() throws {
        try lock.withLock {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
    }
}
