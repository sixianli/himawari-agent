import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum TextBudget {
    public static func scalarPrefix(_ text: String, limit: Int) -> String {
        guard text.unicodeScalars.count > limit else { return text }
        var count = 0
        var kept = String.UnicodeScalarView()
        for character in text {
            let size = character.unicodeScalars.count
            if count + size > limit { break }
            kept.append(contentsOf: character.unicodeScalars)
            count += size
        }
        return String(kept)
    }
}

public enum HandoverEntry: String, Codable, Sendable, CaseIterable {
    case share
    case safari

    public var captureSource: String {
        switch self {
        case .share: "share_extension"
        case .safari: "safari_extension"
        }
    }
}

public enum HandoverContent: Codable, Sendable, Equatable {
    case page(url: String, title: String?, text: String?)
    case link(url: String, title: String?)
    case text(String)
    case image(data: Data, mimeType: String, name: String?)

    public var host: String? {
        switch self {
        case let .page(url, _, _), let .link(url, _): URL(string: url)?.host
        case .text, .image: nil
        }
    }

    public var title: String? {
        switch self {
        case let .page(_, title, _), let .link(_, title): title.flatMap { $0.isEmpty ? nil : $0 }
        case .text, .image: nil
        }
    }

    public func pageSubtitle(fullText: String, outcome: HandoverOutcome?, paired: Bool) -> String? {
        guard case let .page(_, _, text) = self else { return nil }
        let read = paired && !(text ?? "").isEmpty && (outcome?.keepsWhatWasRead ?? true)
        let parts = [host, read ? fullText : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    public static func page(from results: [String: Any]) -> HandoverContent? {
        guard let url = results["url"] as? String, let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(),
              ["http", "https"].contains(scheme) else { return nil }
        let title = (results["title"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let text = (results["text"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return .page(url: url, title: title, text: text)
    }
}

public struct Handover: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let entry: HandoverEntry
    public let content: HandoverContent
    public let request: String?
    public let sourceApp: String?
    public let createdAt: Date
    public let answerLocale: AnswerLocale

    public init(
        id: String = Handover.newId(),
        entry: HandoverEntry,
        content: HandoverContent,
        request: String?,
        sourceApp: String?,
        createdAt: Date,
        answerLocale: AnswerLocale
    ) {
        self.id = id
        self.entry = entry
        self.content = content
        let trimmed = request?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.request = (trimmed?.isEmpty ?? true) ? nil : trimmed
        self.sourceApp = sourceApp.flatMap { $0.isEmpty ? nil : $0 }
        self.createdAt = createdAt
        self.answerLocale = answerLocale
    }

    public static func newId() -> String {
        RandomToken.base64URL(byteCount: 18)
    }

    public var recordId: String { "perception:\(id)" }
    var threadRequestId: String { "\(id)-thread" }
    var messageId: String { "\(id)-message" }
    var attachmentRequestId: String { "\(id)-attachment" }
}

public struct PerceptionFieldRule: Codable, Sendable, Equatable {
    public let kind: String
    public let maximum: Int?
    public let optional: Bool?
}

public struct PerceptionTypeRule: Codable, Sendable, Equatable {
    public let sense: String
    public let text: String
    public let evidence: [String: PerceptionFieldRule]
}

public enum JSONScalar: Codable, Sendable, Equatable, ExpressibleByStringLiteral {
    case string(String)
    case number(Double)
    case bool(Bool)

    public init(stringLiteral value: String) {
        self = .string(value)
    }

    public var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .number(value): try container.encode(value)
        case let .bool(value): try container.encode(value)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else { self = .string(try container.decode(String.self)) }
    }
}

public struct PerceptionRecordUpload: Codable, Sendable, Equatable {
    public let id: String
    public let type: String
    public let captureSource: String
    public let occurredAt: String
    public let confidence: Int
    public let text: String?
    public let evidence: [String: JSONScalar]
}

public enum PerceptionIngestOutcome: String, Codable, Sendable {
    case stored
    case duplicate
    case limitReached = "limit_reached"
    case senseOff = "sense_off"
    case paused
}

public enum HandoverProblem: String, Codable, Sendable, Equatable {
    case tooLarge
    case limitReached
    case serverOutdated
    case rejected
}

public enum HandoverOutcome: Sendable, Equatable {
    case delivered(answered: Bool)
    case queued
    case entryOff(HandoverEntry)
    case deviceRemoved
    case failed(HandoverProblem)
}

extension HandoverOutcome {
    public var keepsWhatWasRead: Bool {
        switch self {
        case .delivered, .queued: true
        case .entryOff, .deviceRemoved, .failed: false
        }
    }
}

public enum HandoverPlan: Sendable, Equatable {
    case conversation(attachment: String, kind: AttachmentKind, name: String, truncated: Bool)
    case record(PerceptionRecordUpload)
    case media(kind: String, contentType: String)
}

public enum HandoverPlanner {
    public static let confidence = 1000
    public static let nameScalars = 40

    public static func plan(_ handover: Handover, configuration: DeviceConfiguration) throws -> HandoverPlan {
        if handover.request != nil {
            guard let limits = configuration.attachments else { throw HandoverPlanError.serverOutdated }
            return try conversationPlan(handover, limits: limits)
        }
        if case let .image(_, mimeType, _) = handover.content {
            return .media(kind: "image", contentType: mimeType)
        }
        guard let types = configuration.perception?.recordTypes else { throw HandoverPlanError.serverOutdated }
        return .record(try record(handover, types: types, textLimit: configuration.perception?.recordTextCharacters))
    }

    static func conversationPlan(_ handover: Handover, limits: AttachmentLimits) throws -> HandoverPlan {
        let name = displayName(handover)
        switch handover.content {
        case let .image(data, mimeType, _):
            let url = "data:\(mimeType);base64,\(data.base64EncodedString())"
            guard url.utf16.count <= limits.imageCharacters else { throw HandoverPlanError.tooLarge }
            return .conversation(attachment: url, kind: .image, name: name, truncated: false)
        case let .page(url, title, text):
            let head = [title, url].compactMap { $0.flatMap { $0.isEmpty ? nil : $0 } }.joined(separator: "\n")
            let body = text.flatMap { $0.isEmpty ? nil : $0 }
            let full = body.map { head + "\n\n" + $0 } ?? head
            let (kept, truncated) = MessageAttachments.clip(full, characters: limits.textCharacters)
            return .conversation(attachment: kept, kind: .text, name: name, truncated: truncated)
        case let .link(url, title):
            let full = [title, url].compactMap { $0.flatMap { $0.isEmpty ? nil : $0 } }.joined(separator: "\n")
            let (kept, truncated) = MessageAttachments.clip(full, characters: limits.textCharacters)
            return .conversation(attachment: kept, kind: .text, name: name, truncated: truncated)
        case let .text(text):
            let (kept, truncated) = MessageAttachments.clip(text, characters: limits.textCharacters)
            return .conversation(attachment: kept, kind: .text, name: name, truncated: truncated)
        }
    }

    static func displayName(_ handover: Handover) -> String {
        switch handover.content {
        case let .image(_, _, name): return name ?? handover.sourceApp ?? "image"
        case .page, .link: return handover.content.title ?? handover.content.host ?? "page"
        case let .text(text):
            let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
            return TextBudget.scalarPrefix(line.trimmingCharacters(in: .whitespaces), limit: nameScalars)
        }
    }

    static func record(_ handover: Handover, types: [String: PerceptionTypeRule], textLimit: Int?) throws -> PerceptionRecordUpload {
        let type: String
        var evidence: [String: String] = [:]
        var text: String?
        switch handover.content {
        case let .page(url, title, body):
            type = "web.page"
            evidence["url"] = url
            evidence["title"] = title
            text = body
        case let .link(url, title):
            type = "share.item"
            evidence["url"] = url
            evidence["title"] = title
            evidence["sourceApp"] = handover.sourceApp
        case let .text(body):
            type = "share.item"
            evidence["sourceApp"] = handover.sourceApp
            text = body
        case .image:
            throw HandoverPlanError.rejected
        }
        guard let rule = types[type] else { throw HandoverPlanError.serverOutdated }
        var fitted: [String: JSONScalar] = [:]
        for (key, value) in evidence where !value.isEmpty {
            guard let field = rule.evidence[key], field.kind == "string" else { continue }
            let kept = field.maximum.map { TextBudget.scalarPrefix(value, limit: $0) } ?? value
            if key == "url", kept != value { throw HandoverPlanError.tooLarge }
            fitted[key] = .string(kept)
        }
        for (key, field) in rule.evidence where field.optional != true && fitted[key] == nil {
            throw HandoverPlanError.rejected
        }
        let bodyText: String?
        switch rule.text {
        case "none": bodyText = nil
        default:
            let trimmed = text.flatMap { $0.isEmpty ? nil : $0 }
            if let trimmed, let textLimit {
                bodyText = MessageAttachments.clip(trimmed, characters: textLimit).text
            } else {
                bodyText = trimmed
            }
            if rule.text == "required", bodyText == nil { throw HandoverPlanError.rejected }
        }
        return PerceptionRecordUpload(
            id: handover.recordId,
            type: type,
            captureSource: handover.entry.captureSource,
            occurredAt: Self.timestamp(handover.createdAt),
            confidence: confidence,
            text: bodyText,
            evidence: fitted
        )
    }

    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}

public enum HandoverPlanError: Error, Sendable {
    case tooLarge
    case serverOutdated
    case rejected

    var problem: HandoverProblem {
        switch self {
        case .tooLarge: .tooLarge
        case .serverOutdated: .serverOutdated
        case .rejected: .rejected
        }
    }
}

public protocol ImageFitting: Sendable {
    func fit(_ data: Data, maxBytes: Int) -> (data: Data, mimeType: String)?
}

public final class HandoverCourier: Sendable {
    private let api: DeviceAPI
    private let images: ImageFitting?

    public init(api: DeviceAPI, images: ImageFitting? = nil) {
        self.api = api
        self.images = images
    }

    static let widestDataURLPrefix = "data:image/jpeg;base64,".utf16.count

    static func imageBudget(_ handover: Handover, configuration: DeviceConfiguration) -> Int? {
        if handover.request != nil {
            guard let limits = configuration.attachments else { return nil }
            let prefix = widestDataURLPrefix
            return max(0, (limits.imageCharacters - prefix) / 4 * 3)
        }
        return configuration.limit("device.upload.file_bytes").map { Int(clamping: $0) }
    }

    func fitted(_ handover: Handover, configuration: DeviceConfiguration) -> Handover {
        guard
            case let .image(data, _, name) = handover.content,
            let images,
            let budget = Self.imageBudget(handover, configuration: configuration),
            data.count > budget,
            let fitted = images.fit(data, maxBytes: budget)
        else { return handover }
        return Handover(
            id: handover.id,
            entry: handover.entry,
            content: .image(data: fitted.data, mimeType: fitted.mimeType, name: name),
            request: handover.request,
            sourceApp: handover.sourceApp,
            createdAt: handover.createdAt,
            answerLocale: handover.answerLocale
        )
    }

    public func deliver(_ original: Handover) async -> HandoverOutcome {
        do {
            let configuration = try await api.configuration()
            let handover = fitted(original, configuration: configuration)
            switch try HandoverPlanner.plan(handover, configuration: configuration) {
            case let .conversation(attachment, kind, name, truncated):
                let ref = try await api.uploadAttachment(requestId: handover.attachmentRequestId, content: attachment, as: kind == .image ? .image : .text)
                let tag = MessageAttachment(name: name, ref: ref, bytes: Data(attachment.utf8).count, kind: kind, truncated: truncated)
                if let limits = configuration.attachments, !MessageAttachments.fits(text: handover.request ?? "", attachments: [tag], limits: limits) {
                    return .failed(.tooLarge)
                }
                let created = try await api.createThread(requestId: handover.threadRequestId, answerLocale: handover.answerLocale)
                let message = OutgoingMessage(
                    messageId: handover.messageId,
                    threadId: created.threadId,
                    expectedRevision: created.threadRevision,
                    text: MessageAttachments.compose(text: handover.request ?? "", attachments: [tag]),
                    createdAt: handover.createdAt
                )
                switch try await api.send(message) {
                case .accepted: return .delivered(answered: true)
                case .conflict: return .failed(.rejected)
                }
            case let .record(record):
                let outcomes = try await api.ingest([record])
                switch outcomes[record.id] {
                case .stored, .duplicate: return .delivered(answered: false)
                case .limitReached: return .failed(.limitReached)
                case .senseOff, .paused: return .entryOff(handover.entry)
                case nil: return .failed(.rejected)
                }
            case let .media(kind, contentType):
                guard case let .image(data, _, _) = handover.content else { return .failed(.rejected) }
                if let budget = configuration.limit("device.upload.file_bytes"), data.count > budget { return .failed(.tooLarge) }
                do {
                    try await api.uploadMedia(data, kind: kind, batchId: handover.id, contentType: contentType)
                } catch DeviceAPIError.server(let status, _, _) where status == 404 || status == 405 {
                    return .failed(.serverOutdated)
                }
                return .delivered(answered: false)
            }
        } catch let error as HandoverPlanError {
            return .failed(error.problem)
        } catch let error as DeviceAPIError {
            return Self.outcome(error)
        } catch {
            return .queued
        }
    }

    static func outcome(_ error: DeviceAPIError) -> HandoverOutcome {
        switch error {
        case .invalidResponse:
            return .queued
        case let .server(status, code, _):
            if error.isRevoked || code == "DEVICE_NOT_PAIRED" { return .deviceRemoved }
            if status == 413 || code == "DEVICE_UPLOAD_TOO_LARGE" { return .failed(.tooLarge) }
            if status == 429 || status >= 500 || status == 408 { return .queued }
            if code == "DEVICE_SIGNATURE_CLOCK_SKEW" || error.isPending { return .queued }
            return .failed(.rejected)
        }
    }
}

public final class HandoverQueue: @unchecked Sendable {
    private let store: LocalStore
    public static let prefix = "handover-item-"

    public init(store: LocalStore) {
        self.store = store
    }

    public func pending() -> [Handover] {
        store.names()
            .filter { $0.hasPrefix(Self.prefix) }
            .compactMap { name in store.read(name).flatMap { try? JSONDecoder().decode(Handover.self, from: $0) } }
            .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    public func add(_ handover: Handover) throws {
        try store.write(Self.prefix + handover.id, try JSONEncoder().encode(handover))
    }

    public func remove(_ id: String) throws {
        try store.write(Self.prefix + id, nil)
    }

    public func drain(using courier: HandoverCourier) async -> [String: HandoverOutcome] {
        var results: [String: HandoverOutcome] = [:]
        for handover in pending() {
            let outcome = await courier.deliver(handover)
            results[handover.id] = outcome
            switch outcome {
            case .queued, .failed(.serverOutdated), .failed(.limitReached): continue
            case .deviceRemoved: return results
            default: try? remove(handover.id)
            }
        }
        return results
    }
}

public struct HandoverSettings: Codable, Sendable, Equatable {
    public var shareOn: Bool
    public var safariOn: Bool
    public var safariUsedAt: Date?

    public init(shareOn: Bool = true, safariOn: Bool = true, safariUsedAt: Date? = nil) {
        self.shareOn = shareOn
        self.safariOn = safariOn
        self.safariUsedAt = safariUsedAt
    }

    public func isOn(_ entry: HandoverEntry) -> Bool {
        switch entry {
        case .share: shareOn
        case .safari: safariOn
        }
    }

    public mutating func set(_ entry: HandoverEntry, on: Bool) {
        switch entry {
        case .share: shareOn = on
        case .safari: safariOn = on
        }
    }

    static let name = "handover-settings"

    public static func load(from store: LocalStore) -> HandoverSettings {
        store.read(name).flatMap { try? JSONDecoder().decode(HandoverSettings.self, from: $0) } ?? HandoverSettings()
    }

    public func save(to store: LocalStore) throws {
        try store.write(Self.name, try JSONEncoder().encode(self))
    }
}

public enum HandoverEntryState: Sendable, Equatable {
    case on
    case off
    case notSetUp
}

extension HandoverSettings {
    public func state(_ entry: HandoverEntry) -> HandoverEntryState {
        if !isOn(entry) { return .off }
        if entry == .safari, safariUsedAt == nil { return .notSetUp }
        return .on
    }
}

public final class HandoverDesk: @unchecked Sendable {
    public let store: LocalStore
    public let queue: HandoverQueue
    private let courier: HandoverCourier
    private let now: @Sendable () -> Date

    public init(store: LocalStore, courier: HandoverCourier, now: @escaping @Sendable () -> Date = Date.init) {
        self.store = store
        self.queue = HandoverQueue(store: store)
        self.courier = courier
        self.now = now
    }

    public var settings: HandoverSettings { HandoverSettings.load(from: store) }

    public func hand(_ handover: Handover) async -> HandoverOutcome {
        var settings = settings
        guard settings.isOn(handover.entry) else { return .entryOff(handover.entry) }
        if handover.entry == .safari, settings.safariUsedAt == nil {
            settings.safariUsedAt = now()
            try? settings.save(to: store)
        }
        _ = await queue.drain(using: courier)
        let outcome = await courier.deliver(handover)
        if outcome == .queued {
            do { try queue.add(handover) } catch { return .failed(.rejected) }
        }
        return outcome
    }
}
