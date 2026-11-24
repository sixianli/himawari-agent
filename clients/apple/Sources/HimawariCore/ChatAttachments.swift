import Foundation

public enum ChatAttachmentContent: Sendable, Equatable {
    case image(data: Data, mimeType: String)
    case text(String, kind: AttachmentKind)
}

public struct ChatAttachment: Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let content: ChatAttachmentContent

    public init(id: String = OutgoingMessage.newId(), name: String, content: ChatAttachmentContent) {
        self.id = id
        self.name = MessageAttachments.cleanName(name)
        self.content = content
    }

    public var isImage: Bool {
        if case .image = content { true } else { false }
    }
}

public enum ChatAttachmentProblem: Error, Equatable, Sendable {
    case serverOutdated
    case tooMany(limit: Int)
    case tooLarge
    case uploadFailed
}

public struct ShownAttachment: Sendable, Equatable {
    public let name: String
    public let kind: AttachmentKind
}

extension MessageAttachments {
    public static func shown(_ text: String) -> (text: String, attachments: [ShownAttachment]) {
        var attachments: [ShownAttachment] = []
        var kept: [String] = []
        for part in text.components(separatedBy: "\n\n") {
            if let tag = parseTag(part.trimmingCharacters(in: .whitespacesAndNewlines)) {
                attachments.append(tag)
            } else {
                kept.append(part)
            }
        }
        guard !attachments.isEmpty else { return (text, []) }
        return (kept.joined(separator: "\n\n"), attachments)
    }

    static func parseTag(_ part: String) -> ShownAttachment? {
        guard part.hasPrefix("<file "), part.hasSuffix("/>") else { return nil }
        let body = part.dropFirst("<file ".count).dropLast(2)
        var fields: [String: String] = [:]
        var rest = Substring(body)
        while let equals = rest.firstIndex(of: "=") {
            let key = rest[..<equals].trimmingCharacters(in: .whitespaces)
            let afterEquals = rest.index(after: equals)
            guard afterEquals < rest.endIndex, rest[afterEquals] == "\"" else { return nil }
            let valueStart = rest.index(after: afterEquals)
            guard let close = rest[valueStart...].firstIndex(of: "\"") else { return nil }
            fields[key] = String(rest[valueStart..<close])
            rest = rest[rest.index(after: close)...]
        }
        guard rest.trimmingCharacters(in: .whitespaces).isEmpty,
              let name = fields["name"], fields["ref"] != nil,
              let kind = fields["kind"].flatMap(AttachmentKind.init(rawValue:))
        else { return nil }
        return ShownAttachment(name: name, kind: kind)
    }
}

public enum ChatAttachmentPlanner {
    static let dataURLPrefix = "data:image/jpeg;base64,".utf16.count

    public static func imageBudget(_ limits: AttachmentLimits) -> Int {
        max(0, (limits.imageCharacters - dataURLPrefix) / 4 * 3)
    }
}

extension DeviceAPI {
    public func compose(text: String, attachments: [ChatAttachment], requestId: String, images: ImageFitting?) async throws -> String {
        guard !attachments.isEmpty else { return text }
        let configuration: DeviceConfiguration
        do {
            configuration = try await self.configuration()
        } catch {
            throw ChatAttachmentProblem.uploadFailed
        }
        guard let limits = configuration.attachments else { throw ChatAttachmentProblem.serverOutdated }
        guard attachments.count <= limits.perMessage else { throw ChatAttachmentProblem.tooMany(limit: limits.perMessage) }
        guard MessageAttachments.fits(text: text, attachments: [], limits: limits) else { throw ChatAttachmentProblem.tooLarge }
        var tags: [MessageAttachment] = []
        for (index, attachment) in attachments.enumerated() {
            let content: String
            let upload: AttachmentUpload
            let kind: AttachmentKind
            var truncated = false
            switch attachment.content {
            case let .image(data, mimeType):
                var payload = (data: data, mimeType: mimeType)
                let budget = ChatAttachmentPlanner.imageBudget(limits)
                if data.count > budget {
                    guard let fitted = images?.fit(data, maxBytes: budget) else { throw ChatAttachmentProblem.tooLarge }
                    payload = fitted
                }
                content = "data:\(payload.mimeType);base64,\(payload.data.base64EncodedString())"
                guard content.utf16.count <= limits.imageCharacters else { throw ChatAttachmentProblem.tooLarge }
                upload = .image
                kind = .image
            case let .text(body, textKind):
                let clipped = MessageAttachments.clip(body, characters: limits.textCharacters)
                content = clipped.text
                truncated = clipped.truncated
                upload = .text
                kind = textKind
            }
            let ref: String
            do {
                ref = try await uploadAttachment(requestId: Self.attachmentRequestId(requestId, index: index), content: content, as: upload)
            } catch {
                throw ChatAttachmentProblem.uploadFailed
            }
            tags.append(MessageAttachment(name: attachment.name, ref: ref, bytes: Data(content.utf8).count, kind: kind, truncated: truncated))
        }
        guard MessageAttachments.fits(text: text, attachments: tags, limits: limits) else { throw ChatAttachmentProblem.tooLarge }
        return MessageAttachments.compose(text: text, attachments: tags)
    }
}
