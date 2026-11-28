import Foundation

public enum ChatAttachmentContent: Sendable, Equatable {
    case image(data: Data, mimeType: String)
    case text(String, kind: AttachmentKind)
}

public struct ChatAttachment: Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let content: ChatAttachmentContent
    public let originalBytes: Int?

    public init(id: String = OutgoingMessage.newId(), name: String, content: ChatAttachmentContent, originalBytes: Int? = nil) {
        self.id = id
        self.name = MessageAttachments.cleanName(name)
        self.content = content
        self.originalBytes = originalBytes
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
    case imagesUnsupported
}

public struct ShownAttachment: Sendable, Equatable {
    public let name: String
    public let kind: AttachmentKind
}

extension MessageAttachments {
    public static func preview(_ text: String) -> String {
        let shown = shown(text)
        guard !shown.attachments.isEmpty else { return shown.text }
        let body = shown.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? shown.attachments[0].name : body
    }

    public static func shown(_ text: String) -> (text: String, attachments: [ShownAttachment]) {
        let text = MessageReply.split(text).text
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
    public static let bytesPerMegabyte = 1024 * 1024
    public static let maxFileBytes = 20 * bytesPerMegabyte
    public static let maxImagePixels = 4096

    public static func fileFits(bytes: Int?) -> Bool {
        guard let bytes else { return false }
        return bytes <= maxFileBytes
    }

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
        guard limits.imageCharacters > 0 || !attachments.contains(where: \.isImage) else { throw ChatAttachmentProblem.imagesUnsupported }
        guard MessageAttachments.fits(text: text, attachments: [], limits: limits) else { throw ChatAttachmentProblem.tooLarge }
        var tags: [MessageAttachment] = []
        for (index, attachment) in attachments.enumerated() {
            let content: String
            let upload: AttachmentUpload
            let kind: AttachmentKind
            let bytes: Int
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
                bytes = attachment.originalBytes ?? data.count
            case let .text(body, textKind):
                let clipped = MessageAttachments.clip(body, characters: limits.textCharacters)
                content = clipped.text
                truncated = clipped.truncated
                upload = .text
                kind = textKind
                bytes = attachment.originalBytes ?? Data(body.utf8).count
            }
            let ref: String
            do {
                ref = try await uploadAttachment(requestId: Self.attachmentRequestId(requestId, index: index), content: content, as: upload)
            } catch let DeviceAPIError.server(status, _, _, _) where status == 415 {
                throw ChatAttachmentProblem.imagesUnsupported
            } catch {
                throw ChatAttachmentProblem.uploadFailed
            }
            tags.append(MessageAttachment(name: attachment.name, ref: ref, bytes: bytes, kind: kind, truncated: truncated))
        }
        guard MessageAttachments.fits(text: text, attachments: tags, limits: limits) else { throw ChatAttachmentProblem.tooLarge }
        return MessageAttachments.compose(text: text, attachments: tags)
    }
}
