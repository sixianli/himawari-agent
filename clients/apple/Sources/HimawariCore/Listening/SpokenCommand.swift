import Foundation

public enum VoiceTrigger: String, Codable, Sendable, CaseIterable {
    case airpodsName = "airpods_name"
    case handsOn = "hands_on"
    case ambientName = "ambient_name"
}

public enum AudioInputRoute: String, Codable, Sendable {
    case airpods
    case deviceMicrophone = "device_microphone"
    case wearableMicrophone = "wearable_microphone"
}

public struct VoiceEvidence: Codable, Sendable, Equatable {
    public let trigger: VoiceTrigger
    public let speakerScore: Int?
    public let inputRoute: AudioInputRoute?
    public let inEar: Bool?
    public let loudnessScore: Int?
    public let heardName: String?

    public static let heardNameMaximumCharacters = 64

    static func normalizedHeardName(_ name: String) -> String? {
        let scalars = name.unicodeScalars.filter { $0.properties.generalCategory != .control && $0.properties.generalCategory != .format }
        var clipped = String(String.UnicodeScalarView(scalars.prefix(heardNameMaximumCharacters)))
        clipped = clipped.trimmingCharacters(in: .whitespacesAndNewlines)
        return clipped.isEmpty ? nil : clipped
    }

    public init(trigger: VoiceTrigger, speakerScore: Int? = nil, inputRoute: AudioInputRoute? = nil, inEar: Bool? = nil, loudnessScore: Int? = nil, heardName: String? = nil) {
        self.trigger = trigger
        self.speakerScore = speakerScore.map(VoiceScore.clamp)
        self.inputRoute = inputRoute
        self.inEar = inEar
        self.loudnessScore = loudnessScore.map(VoiceScore.clamp)
        self.heardName = trigger == .handsOn ? nil : heardName.flatMap(Self.normalizedHeardName)
    }
}

public enum VoiceScore {
    public static let maximum = 1000

    public static func clamp(_ value: Int) -> Int {
        min(max(value, 0), maximum)
    }

    public static func fromUnit(_ value: Double) -> Int {
        guard value.isFinite else { return 0 }
        return clamp(Int((value * Double(maximum)).rounded(.down)))
    }

    public static func loudness(dbfs: Double) -> Int {
        guard dbfs.isFinite else { return 0 }
        return clamp(Int(((dbfs + 100) * 10).rounded(.down)))
    }
}

public struct SpokenMessage: Sendable, Equatable {
    public let message: OutgoingMessage
    public let utteranceId: String
    public let voice: VoiceEvidence

    public init(message: OutgoingMessage, utteranceId: String, voice: VoiceEvidence) {
        self.message = message
        self.utteranceId = utteranceId
        self.voice = voice
    }
}

public enum SpokenCommandRefusal: String, Sendable, Equatable {
    case airpodsRouteMismatch = "airpods_route_mismatch"
    case airpodsNotInEar = "airpods_not_in_ear"
    case airpodsFar = "airpods_far"
    case speakerUnconfirmed = "speaker_unconfirmed"
    case notAddressed = "not_addressed"
    case addressedUnsure = "addressed_unsure"
    case addressedBudget = "addressed_budget"

    public var asksOwner: Bool { self != .notAddressed }
}

public enum SpokenCommandOutcome: Sendable, Equatable {
    case sent(CommandOutcome)
    case askFirst(SpokenCommandRefusal)
}

public struct PartialPreparation: Codable, Sendable, Equatable {
    public let prepared: Bool
    public let reason: String?
}

extension DeviceAPI {
    public static let voiceCommandUnconfirmedCode = "VOICE_COMMAND_UNCONFIRMED"

    public func send(_ spoken: SpokenMessage) async throws -> SpokenCommandOutcome {
        struct Body: Encodable {
            let messageId: String
            let threadId: String
            let expectedRevision: Int
            let text: String
            let utteranceId: String
            let voice: VoiceEvidence
        }
        let message = spoken.message
        let body = Body(
            messageId: message.messageId,
            threadId: message.threadId,
            expectedRevision: message.expectedRevision,
            text: message.text,
            utteranceId: spoken.utteranceId,
            voice: spoken.voice
        )
        do {
            let data = try await http.send(DeviceRequest(method: "POST", path: "messages", body: try JSONEncoder().encode(body)))
            return .sent(try outcome(data))
        } catch let error as DeviceAPIError {
            guard
                case let .server(status, code, _, reason) = error,
                status == 409,
                code == Self.voiceCommandUnconfirmedCode,
                let refusal = reason.flatMap(SpokenCommandRefusal.init(rawValue:))
            else { throw error }
            return .askFirst(refusal)
        }
    }

    public func prepare(utteranceId: String, partialText: String) async throws -> PartialPreparation {
        struct Body: Encodable {
            let utteranceId: String
            let text: String
        }
        let data = try await http.send(DeviceRequest(method: "POST", path: "utterances/partial", body: try JSONEncoder().encode(Body(utteranceId: utteranceId, text: partialText))))
        return try decode(PartialPreparation.self, data)
    }
}
