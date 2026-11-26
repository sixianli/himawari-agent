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
    public var saidAt: Date?
    public var firstTextAt: Date?
    public var firstSoundAt: Date?
    public var serverFirstAudioMs: Int?
    public var route: SpeechRoute?

    public init() {}
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
