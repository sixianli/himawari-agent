import Foundation

public struct DeviceRequestTarget: Sendable, Equatable {
    public let method: String
    public let authority: String
    public let path: String
    public let rawQuery: String
    public let body: Data?
    public let contentType: String?

    public init(method: String, authority: String, path: String, rawQuery: String, body: Data?, contentType: String?) {
        self.method = method.uppercased()
        self.authority = authority.lowercased()
        self.path = path
        self.rawQuery = rawQuery
        self.body = (body?.isEmpty ?? true) ? nil : body
        self.contentType = self.body == nil ? nil : contentType
    }
}

public struct DeviceSignatureParameters: Sendable, Equatable {
    public let deviceId: String
    public let created: Int64
    public let nonce: String

    public init(deviceId: String, created: Int64, nonce: String) {
        self.deviceId = deviceId
        self.created = created
        self.nonce = nonce
    }
}

public enum DeviceSignature {
    public static let tag = "himawari-device-v1"
    public static let algorithm = "ecdsa-p256-sha256"
    public static let deviceLabel = "device"
    public static let confirmLabel = "confirm"

    public static func contentDigest(_ body: Data) -> String {
        "sha-256=:\(Hashing.sha256(body).base64EncodedString()):"
    }

    public static func components(hasBody: Bool) -> [String] {
        let base = ["@method", "@authority", "@path", "@query"]
        return hasBody ? base + ["content-digest", "content-type"] : base
    }

    public static func signatureParams(components: [String], parameters: DeviceSignatureParameters) -> String {
        let list = components.map { "\"\($0)\"" }.joined(separator: " ")
        return "(\(list));created=\(parameters.created);nonce=\"\(parameters.nonce)\";keyid=\"\(parameters.deviceId)\";alg=\"\(algorithm)\";tag=\"\(tag)\""
    }

    public static func signatureBase(target: DeviceRequestTarget, parameters: DeviceSignatureParameters) -> String {
        let components = components(hasBody: target.body != nil)
        let digest = target.body.map(contentDigest) ?? ""
        var lines: [String] = []
        for component in components {
            switch component {
            case "@method": lines.append("\"@method\": \(target.method)")
            case "@authority": lines.append("\"@authority\": \(target.authority)")
            case "@path": lines.append("\"@path\": \(target.path)")
            case "@query": lines.append("\"@query\": ?\(target.rawQuery)")
            case "content-digest": lines.append("\"content-digest\": \(digest)")
            default: lines.append("\"content-type\": \(target.contentType ?? "")")
            }
        }
        lines.append("\"@signature-params\": \(signatureParams(components: components, parameters: parameters))")
        return lines.joined(separator: "\n")
    }

    public static func headers(
        target: DeviceRequestTarget,
        parameters: DeviceSignatureParameters,
        signer: DeviceKeySigner,
        confirmSigner: DeviceKeySigner? = nil,
        confirmReason: String? = nil
    ) async throws -> [String: String] {
        let base = Data(signatureBase(target: target, parameters: parameters).utf8)
        var signatures = [(deviceLabel, try await signer.sign(base, reason: nil))]
        if let confirmSigner {
            signatures.append((confirmLabel, try await confirmSigner.sign(base, reason: confirmReason)))
        }
        for (_, signature) in signatures where signature.count != 64 {
            throw DeviceKeyError.signatureLength(signature.count)
        }
        let params = signatureParams(components: components(hasBody: target.body != nil), parameters: parameters)
        var headers = [
            "Signature-Input": signatures.map { "\($0.0)=\(params)" }.joined(separator: ", "),
            "Signature": signatures.map { "\($0.0)=:\($0.1.base64EncodedString()):" }.joined(separator: ", "),
        ]
        if let body = target.body {
            headers["Content-Digest"] = contentDigest(body)
            headers["Content-Type"] = target.contentType ?? ""
        }
        return headers
    }

    public static func newNonce() -> String {
        RandomToken.base64URL(byteCount: 16)
    }
}
