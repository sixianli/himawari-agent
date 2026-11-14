import Foundation

public enum AttachmentUpload: String, Codable, Sendable {
    case text
    case image
}

extension DeviceAPI {
    public func uploadAttachment(requestId: String, content: String, as upload: AttachmentUpload) async throws -> String {
        struct Body: Encodable {
            let requestId: String
            let content: String
            let `as`: AttachmentUpload
        }
        struct Reply: Decodable { let ref: String }
        let body = try JSONEncoder().encode(Body(requestId: requestId, content: content, as: upload))
        let data = try await http.send(DeviceRequest(method: "POST", path: "attachments", body: body))
        let ref = try decode(Reply.self, data).ref
        guard !ref.isEmpty, !ref.contains(where: { $0.isWhitespace || "\"<>".contains($0) }) else {
            throw DeviceAPIError.invalidResponse
        }
        return ref
    }

    public static func attachmentRequestId(_ requestId: String, index: Int) -> String {
        "\(requestId)-\(index)"
    }

    public func attach(_ pieces: [ContextPiece], requestId: String, limits: AttachmentLimits) async throws -> [MessageAttachment] {
        var attachments: [MessageAttachment] = []
        for (index, piece) in pieces.enumerated() {
            let clipped = MessageAttachments.clip(piece.content, characters: limits.textCharacters)
            let ref = try await uploadAttachment(requestId: Self.attachmentRequestId(requestId, index: index), content: clipped.text, as: .text)
            attachments.append(MessageAttachment(
                name: piece.name,
                ref: ref,
                bytes: piece.bytes ?? piece.content.utf8.count,
                kind: piece.kind,
                truncated: clipped.truncated
            ))
        }
        return attachments
    }
}
