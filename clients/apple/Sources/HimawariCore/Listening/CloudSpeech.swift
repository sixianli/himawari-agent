import Foundation

public enum SpeechRoute: Sendable, Equatable {
    case cloud
    case local
}

public struct CloudSpeechPolicy: Sendable, Equatable {
    public static let maximumCharacters = 600
    public static let firstAudioDeadline: Duration = .milliseconds(1500)
    public static let maximumInFlight = 2

    public private(set) var disabled = false
    public private(set) var localThisTurn = false

    public init() {}

    public func route(_ sentence: String) -> SpeechRoute {
        guard !disabled, !localThisTurn, sentence.count <= Self.maximumCharacters else { return .local }
        return .cloud
    }

    public mutating func failed(status: Int?) {
        switch status {
        case 503: disabled = true
        case 422: break
        default: localThisTurn = true
        }
    }

    public mutating func newTurn() {
        localThisTurn = false
    }
}

public struct PCM16Decoder: Sendable, Equatable {
    private var carry: UInt8?

    public init() {}

    public mutating func samples(_ data: Data) -> [Float] {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(data.count + 1)
        if let carry { bytes.append(carry) }
        bytes.append(contentsOf: data)
        carry = bytes.count.isMultiple(of: 2) ? nil : bytes.removeLast()
        var samples = [Float](repeating: 0, count: bytes.count / 2)
        for index in samples.indices {
            let low = UInt16(bytes[2 * index])
            let high = UInt16(bytes[2 * index + 1])
            samples[index] = Float(Int16(bitPattern: low | high << 8)) / 32768
        }
        return samples
    }
}

public struct CloudSpeechAudio: Sendable {
    public let sampleRate: Double
    public let firstAudioMs: Int?
    public let chunks: AsyncThrowingStream<Data, Error>
}

public struct TalkTurnTiming: Sendable, Equatable {
    public var messageId: String?
    public var saidAt: Date?
    public var firstTextAt: Date?
    public var firstSoundAt: Date?
    public var serverFirstAudioMs: Int?
    public var route: SpeechRoute?

    public init() {}

    public var report: VoiceTiming? {
        guard let messageId, let saidAt, let firstTextAt else { return nil }
        return VoiceTiming(messageId: messageId, saidAt: saidAt, firstTextAt: firstTextAt, firstSoundAt: firstSoundAt)
    }
}

public struct VoiceTiming: Sendable, Equatable, Encodable {
    public static let retryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(15)]

    public let messageId: String
    public let saidAt: Date
    public let firstTextAt: Date
    public let firstSoundAt: Date?

    public init(messageId: String, saidAt: Date, firstTextAt: Date, firstSoundAt: Date?) {
        self.messageId = messageId
        self.saidAt = saidAt
        self.firstTextAt = firstTextAt
        self.firstSoundAt = firstSoundAt
    }

    private enum CodingKeys: String, CodingKey {
        case messageId, saidAt, firstTextAt, firstSoundAt
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(messageId, forKey: .messageId)
        try container.encode(Self.stamp(saidAt), forKey: .saidAt)
        try container.encode(Self.stamp(firstTextAt), forKey: .firstTextAt)
        if let firstSoundAt {
            try container.encode(Self.stamp(firstSoundAt), forKey: .firstSoundAt)
        } else {
            try container.encodeNil(forKey: .firstSoundAt)
        }
    }

    public static func stamp(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: TimeZone(identifier: "UTC") ?? .gmt))
    }

    public static func worthRetrying(_ error: Error) -> Bool {
        if case let .server(status, _, _, _)? = error as? DeviceAPIError { return status == 404 || status >= 500 }
        return error is URLError
    }
}

extension DeviceAPI {
    public func speech(_ text: String) async throws -> CloudSpeechAudio {
        struct Body: Encodable { let text: String }
        let response = try await http.openBytes(DeviceRequest(method: "POST", path: "speech", body: try JSONEncoder().encode(Body(text: text))))
        guard let rateText = response.header("x-himawari-speech-sample-rate"), let rate = Double(rateText), rate > 0 else {
            throw DeviceAPIError.invalidResponse
        }
        return CloudSpeechAudio(
            sampleRate: rate,
            firstAudioMs: response.header("x-himawari-speech-first-audio-ms").flatMap { Int($0) },
            chunks: response.chunks
        )
    }
}

extension DeviceAPI {
    public func voiceTiming(_ timing: VoiceTiming) async throws {
        _ = try await http.send(DeviceRequest(method: "POST", path: "voice-timing", body: try JSONEncoder().encode(timing)))
    }

    public func reportVoiceTiming(_ timing: VoiceTiming, sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) async {
        var delays = VoiceTiming.retryDelays[...]
        while true {
            do {
                try await voiceTiming(timing)
                return
            } catch {
                guard VoiceTiming.worthRetrying(error), let delay = delays.popFirst() else { return }
                do { try await sleep(delay) } catch { return }
            }
        }
    }
}
