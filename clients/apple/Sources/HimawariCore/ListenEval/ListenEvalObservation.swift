import Foundation

public enum ListenEvalSource: String, Codable, Sendable, CaseIterable {
    case owner
    case publicCorpus = "public"
    case synthetic
}

public struct ListenEvalClip: Codable, Sendable, Equatable {
    public let id: String
    public let file: String
    public let purpose: ListenEvalPurpose
    public let source: ListenEvalSource
    public let speaker: String
    public let language: String
    public let reference: String
    public let placement: ListenEvalPlacement
    public let condition: ListenEvalCondition
    public let route: AudioInputRoute
    public let inEar: Bool?

    public init(id: String, file: String, purpose: ListenEvalPurpose, source: ListenEvalSource, speaker: String, language: String, reference: String, placement: ListenEvalPlacement, condition: ListenEvalCondition, route: AudioInputRoute, inEar: Bool?) {
        self.id = id
        self.file = file
        self.purpose = purpose
        self.source = source
        self.speaker = speaker
        self.language = language
        self.reference = reference
        self.placement = placement
        self.condition = condition
        self.route = route
        self.inEar = inEar
    }
}

public struct ListenEvalPiece: Codable, Sendable, Equatable {
    public let at: Double
    public let start: Double
    public let text: String
    public let isFinal: Bool

    public init(at: Double, start: Double, text: String, isFinal: Bool) {
        self.at = at
        self.start = start
        self.text = text
        self.isFinal = isFinal
    }
}

public struct ListenEvalTranscript: Codable, Sendable, Equatable {
    public let engine: String
    public let locale: String
    public let pieces: [ListenEvalPiece]
    public let processingSeconds: Double

    public init(engine: String, locale: String, pieces: [ListenEvalPiece], processingSeconds: Double) {
        self.engine = engine
        self.locale = locale
        self.pieces = pieces
        self.processingSeconds = processingSeconds
    }

    public var text: String {
        pieces.filter(\.isFinal).map(\.text).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var speechSpan: ClosedRange<Double>? {
        let finals = pieces.filter(\.isFinal)
        guard let first = finals.map(\.start).min(), let last = finals.map(\.at).max(), last > first else { return nil }
        return first...last
    }
}

public struct ListenEvalCall: Codable, Sendable, Equatable {
    public let nameHeard: Bool
    public let request: String?
    public let prepared: [String]
    public let heardName: String?

    public init(nameHeard: Bool, request: String?, prepared: [String], heardName: String? = nil) {
        self.nameHeard = nameHeard
        self.request = request
        self.prepared = prepared
        self.heardName = heardName
    }
}

public struct ListenEvalObservation: Codable, Sendable, Equatable {
    public let clip: ListenEvalClip
    public let transcripts: [ListenEvalTranscript]
    public let speakerModel: String?
    public let speakerScore: Int?
    public let loudnessScore: Int?
    public let call: ListenEvalCall?

    public init(clip: ListenEvalClip, transcripts: [ListenEvalTranscript], speakerModel: String?, speakerScore: Int?, loudnessScore: Int?, call: ListenEvalCall?) {
        self.clip = clip
        self.transcripts = transcripts
        self.speakerModel = speakerModel
        self.speakerScore = speakerScore
        self.loudnessScore = loudnessScore
        self.call = call
    }
}

public enum ListenEvalReplay {
    public static func call(names: NameCall, policy: SpokenRequestPolicy = .designed, pieces: [ListenEvalPiece]) -> ListenEvalCall {
        let origin = Date(timeIntervalSinceReferenceDate: 0)
        var flow = UtteranceFlow(names: names, policy: policy)
        var open = false
        var prepared: [String] = []
        var nameHeard = false
        for piece in pieces {
            let now = origin.addingTimeInterval(piece.at)
            if !open {
                flow.begin(.heard, at: now, utteranceId: "eval")
                open = true
                prepared = []
            }
            if !piece.isFinal {
                for step in flow.partial(piece.text, at: now) {
                    switch step {
                    case .heardName: nameHeard = true
                    case let .prepare(_, text): prepared.append(text)
                    }
                }
                continue
            }
            open = false
            let speech = HeardSpeech(text: piece.text, startedAt: origin.addingTimeInterval(piece.start), duration: max(0, piece.at - piece.start), language: nil, confidence: 0, source: .deviceMicrophone, ownerScore: nil)
            switch flow.finish(speech, mode: .nameOnly, at: now) {
            case let .command(request, _, _, heardName):
                return ListenEvalCall(nameHeard: true, request: request, prepared: prepared, heardName: heardName)
            case .calledOnly:
                nameHeard = true
            case .record, .nothing:
                break
            }
        }
        return ListenEvalCall(nameHeard: nameHeard, request: nil, prepared: [])
    }
}
