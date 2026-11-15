import Foundation

public enum SenseRecordError: Error, Sendable, Equatable {
    case typeUnknown(String)
    case fieldMissing(String)
    case fieldInvalid(String)
    case textMissing
}

public struct SenseObservation: Sendable, Equatable {
    public let type: String
    public let occurredAt: Date
    public let text: String?
    public let evidence: [String: JSONScalar]
    public let confidence: Int

    public init(type: String, occurredAt: Date, text: String? = nil, evidence: [String: JSONScalar], confidence: Int = 1000) {
        self.type = type
        self.occurredAt = occurredAt
        self.text = text
        self.evidence = evidence
        self.confidence = confidence
    }
}

public enum SenseRecordBuilder {
    public static let captureSource = "system_api"
    public static let sensorSource = "device_sensor"

    public static func record(
        _ observation: SenseObservation,
        id: String = SenseRecordBuilder.newId(),
        captureSource: String = SenseRecordBuilder.captureSource,
        types: [String: PerceptionTypeRule],
        textLimit: Int?
    ) throws -> PerceptionRecordUpload {
        guard let rule = types[observation.type] else { throw SenseRecordError.typeUnknown(observation.type) }
        var fitted: [String: JSONScalar] = [:]
        for (key, value) in observation.evidence {
            guard let field = rule.evidence[key] else { continue }
            fitted[key] = try fit(value, field: field, key: key)
        }
        for (key, field) in rule.evidence where field.optional != true && fitted[key] == nil {
            throw SenseRecordError.fieldMissing(key)
        }
        let text: String?
        switch rule.text {
        case "none":
            text = nil
        default:
            let trimmed = observation.text.flatMap { $0.isEmpty ? nil : $0 }
            text = trimmed.map { value in textLimit.map { TextBudget.scalarPrefix(value, limit: $0) } ?? value }
            if rule.text == "required", text == nil { throw SenseRecordError.textMissing }
        }
        return PerceptionRecordUpload(
            id: id,
            type: observation.type,
            captureSource: captureSource,
            occurredAt: HandoverPlanner.timestamp(observation.occurredAt),
            confidence: max(0, min(1000, observation.confidence)),
            text: text,
            evidence: fitted
        )
    }

    static func fit(_ value: JSONScalar, field: PerceptionFieldRule, key: String) throws -> JSONScalar {
        switch (field.kind, value) {
        case let ("string", .string(text)):
            guard !text.isEmpty else { throw SenseRecordError.fieldInvalid(key) }
            return .string(field.maximum.map { TextBudget.scalarPrefix(text, limit: $0) } ?? text)
        case ("enum", .string):
            return value
        case let ("integer", .number(number)):
            guard number.isFinite else { throw SenseRecordError.fieldInvalid(key) }
            return .number(number.rounded())
        case let ("number", .number(number)):
            guard number.isFinite else { throw SenseRecordError.fieldInvalid(key) }
            return value
        case ("boolean", .bool):
            return value
        default:
            throw SenseRecordError.fieldInvalid(key)
        }
    }

    public static func newId() -> String {
        "perception:" + RandomToken.base64URL(byteCount: 18)
    }

    public static func stableId(_ parts: [String]) -> String {
        let digest = Hashing.sha256(Data(parts.joined(separator: "\n").utf8))
        return "perception:" + digest.prefix(24).base64URLEncodedString()
    }

    public static func milliseconds(_ date: Date) -> JSONScalar {
        .number((date.timeIntervalSince1970 * 1000).rounded())
    }
}

public enum SenseObservations {
    public static func visit(
        latitude: Double,
        longitude: Double,
        accuracyMeters: Double?,
        arrivedAt: Date?,
        departedAt: Date?,
        placeName: String?
    ) -> SenseObservation {
        var evidence: [String: JSONScalar] = ["latitude": .number(latitude), "longitude": .number(longitude)]
        if let accuracyMeters, accuracyMeters >= 0 { evidence["accuracyMeters"] = .number(accuracyMeters) }
        if let arrivedAt { evidence["arrivedAtMs"] = SenseRecordBuilder.milliseconds(arrivedAt) }
        if let departedAt { evidence["departedAtMs"] = SenseRecordBuilder.milliseconds(departedAt) }
        if let placeName, !placeName.isEmpty { evidence["placeName"] = .string(placeName) }
        return SenseObservation(type: "location.visit", occurredAt: arrivedAt ?? departedAt ?? Date(), evidence: evidence)
    }

    public static func region(id: String, entered: Bool, latitude: Double?, longitude: Double?, at date: Date) -> SenseObservation {
        var evidence: [String: JSONScalar] = ["regionId": .string(id), "transition": .string(entered ? "enter" : "exit")]
        if let latitude { evidence["latitude"] = .number(latitude) }
        if let longitude { evidence["longitude"] = .number(longitude) }
        return SenseObservation(type: "location.region", occurredAt: date, evidence: evidence)
    }

    public enum HealthKind: String, Sendable, CaseIterable {
        case steps
        case sleep
        case heartRate = "heart_rate"
        case workout
    }

    public static func health(_ kind: HealthKind, value: Double, unit: String, start: Date, end: Date, workoutType: String? = nil) -> SenseObservation {
        var evidence: [String: JSONScalar] = [
            "subtype": .string(kind.rawValue),
            "value": .number(value),
            "unit": .string(unit),
            "startMs": SenseRecordBuilder.milliseconds(start),
            "endMs": SenseRecordBuilder.milliseconds(end),
        ]
        if let workoutType, !workoutType.isEmpty { evidence["workoutType"] = .string(workoutType) }
        return SenseObservation(type: "health.sample", occurredAt: end, evidence: evidence)
    }

    public enum Activity: String, Sendable, CaseIterable {
        case stationary
        case walking
        case running
        case cycling
        case driving
    }

    public enum Certainty: String, Sendable {
        case low
        case medium
        case high
    }

    public static func motion(_ activity: Activity, certainty: Certainty, at date: Date) -> SenseObservation {
        SenseObservation(
            type: "motion.activity",
            occurredAt: date,
            evidence: ["activity": .string(activity.rawValue), "certainty": .string(certainty.rawValue)]
        )
    }

    public static func photo(assetId: String, screenshot: Bool, createdAt: Date, latitude: Double?, longitude: Double?) -> SenseObservation {
        var evidence: [String: JSONScalar] = ["assetId": .string(assetId)]
        if !screenshot, let latitude, let longitude {
            evidence["latitude"] = .number(latitude)
            evidence["longitude"] = .number(longitude)
        }
        return SenseObservation(type: screenshot ? "photo.screenshot" : "photo.asset", occurredAt: createdAt, evidence: evidence)
    }

    public static func clipboard(text: String, sourceApp: String?, at date: Date) -> SenseObservation {
        var evidence: [String: JSONScalar] = [:]
        if let sourceApp, !sourceApp.isEmpty { evidence["sourceApp"] = .string(sourceApp) }
        return SenseObservation(type: "clipboard.item", occurredAt: date, text: text, evidence: evidence)
    }
}
