import Foundation

public struct SetupCodeRule: Codable, Sendable, Equatable {
    public let length: Int
    public let groupSize: Int
    public let alphabet: String

    public init(length: Int, groupSize: Int, alphabet: String) {
        self.length = length
        self.groupSize = groupSize
        self.alphabet = alphabet
    }

    public static func normalized(_ input: String) -> String {
        String(input.uppercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII }.map(Character.init))
    }

    public func normalized(_ input: String) -> String {
        String(Self.normalized(input).prefix(max(length, 0)))
    }

    public func display(_ input: String) -> String {
        let code = normalized(input)
        guard groupSize > 0 else { return code }
        var shown = ""
        for (index, character) in code.enumerated() {
            if index > 0, index % groupSize == 0 { shown.append("-") }
            shown.append(character)
        }
        return shown
    }

    public func isComplete(_ input: String) -> Bool {
        let code = normalized(input)
        let allowed = Set(alphabet)
        return code.count == length && code.allSatisfy { allowed.isEmpty || allowed.contains($0) }
    }
}

public enum SetupCodeEntry {
    public static func display(_ input: String, rule: SetupCodeRule?) -> String {
        rule?.display(input) ?? SetupCodeRule.normalized(input)
    }

    public static func ready(_ input: String, rule: SetupCodeRule?) -> Bool {
        guard let rule else { return !SetupCodeRule.normalized(input).isEmpty }
        return rule.isComplete(input)
    }

    public static func submitted(_ input: String, rule: SetupCodeRule?) -> String {
        display(input, rule: rule)
    }
}

public struct SignInInfo: Codable, Sendable, Equatable {
    public let rpId: String
    public let setupCode: SetupCodeRule

    public init(rpId: String, setupCode: SetupCodeRule) {
        self.rpId = rpId
        self.setupCode = setupCode
    }
}

public struct SignInDevice: Codable, Sendable, Equatable {
    public let kind: DeviceKind
    public let name: String
    public let releaseChannel: ReleaseChannel
    public let devicePublicKey: String
    public let confirmPublicKey: String

    public init(kind: DeviceKind, name: String, releaseChannel: ReleaseChannel, devicePublicKey: Data, confirmPublicKey: Data) {
        self.kind = kind
        self.name = name
        self.releaseChannel = releaseChannel
        self.devicePublicKey = devicePublicKey.base64EncodedString()
        self.confirmPublicKey = confirmPublicKey.base64EncodedString()
    }
}

public struct PasskeyRegistrationOptions: Sendable, Equatable {
    public let relyingParty: String
    public let challenge: Data
    public let userId: Data
    public let userName: String
    public let excluded: [Data]
}

public struct PasskeyAssertionOptions: Sendable, Equatable {
    public let relyingParty: String
    public let challenge: Data
    public let allowed: [Data]
}

public struct PasskeyRegistration: Sendable, Equatable {
    public let credentialId: Data
    public let clientDataJSON: Data
    public let attestationObject: Data

    public init(credentialId: Data, clientDataJSON: Data, attestationObject: Data) {
        self.credentialId = credentialId
        self.clientDataJSON = clientDataJSON
        self.attestationObject = attestationObject
    }
}

public struct PasskeyAssertion: Sendable, Equatable {
    public let credentialId: Data
    public let clientDataJSON: Data
    public let authenticatorData: Data
    public let signature: Data
    public let userHandle: Data?

    public init(credentialId: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userHandle: Data?) {
        self.credentialId = credentialId
        self.clientDataJSON = clientDataJSON
        self.authenticatorData = authenticatorData
        self.signature = signature
        self.userHandle = userHandle
    }
}

public enum PasskeyCeremonyError: Error, Equatable, Sendable {
    case canceled
    case noCredential
    case failed(String)
}

public protocol PasskeyCeremony: Sendable {
    func register(_ options: PasskeyRegistrationOptions) async throws -> PasskeyRegistration
    func assert(_ options: PasskeyAssertionOptions, immediatelyAvailableOnly: Bool) async throws -> PasskeyAssertion
}

public struct SignInStart<Options: Sendable>: Sendable {
    public let flowId: String
    public let options: Options
}

enum WebAuthnJSON {
    struct Descriptor: Decodable {
        let id: String
    }

    struct Creation: Decodable {
        struct RelyingParty: Decodable { let id: String? }
        struct User: Decodable {
            let id: String
            let name: String
        }
        let challenge: String
        let rp: RelyingParty
        let user: User
        let excludeCredentials: [Descriptor]?
    }

    struct Request: Decodable {
        let challenge: String
        let rpId: String?
        let allowCredentials: [Descriptor]?
    }

    struct Started<Options: Decodable>: Decodable {
        let flowId: String
        let publicKey: Options
    }

    static func bytes(_ text: String) throws -> Data {
        guard let data = Data(base64URLEncoded: text) else { throw DeviceAPIError.invalidResponse }
        return data
    }

    static func registration(_ data: Data, fallbackRelyingParty: String) throws -> SignInStart<PasskeyRegistrationOptions> {
        guard let started = try? JSONDecoder().decode(Started<Creation>.self, from: data) else { throw DeviceAPIError.invalidResponse }
        let key = started.publicKey
        let relyingParty = key.rp.id ?? fallbackRelyingParty
        guard !relyingParty.isEmpty, !started.flowId.isEmpty else { throw DeviceAPIError.invalidResponse }
        return SignInStart(flowId: started.flowId, options: PasskeyRegistrationOptions(
            relyingParty: relyingParty,
            challenge: try bytes(key.challenge),
            userId: try bytes(key.user.id),
            userName: key.user.name,
            excluded: try (key.excludeCredentials ?? []).map { try bytes($0.id) }
        ))
    }

    static func assertion(_ data: Data, fallbackRelyingParty: String) throws -> SignInStart<PasskeyAssertionOptions> {
        guard let started = try? JSONDecoder().decode(Started<Request>.self, from: data) else { throw DeviceAPIError.invalidResponse }
        let key = started.publicKey
        let relyingParty = key.rpId ?? fallbackRelyingParty
        guard !relyingParty.isEmpty, !started.flowId.isEmpty else { throw DeviceAPIError.invalidResponse }
        return SignInStart(flowId: started.flowId, options: PasskeyAssertionOptions(
            relyingParty: relyingParty,
            challenge: try bytes(key.challenge),
            allowed: try (key.allowCredentials ?? []).map { try bytes($0.id) }
        ))
    }

    static func registrationResponse(_ registration: PasskeyRegistration) -> [String: SignInJSON] {
        let id = registration.credentialId.base64URLEncodedString()
        return [
            "id": .string(id),
            "rawId": .string(id),
            "type": .string("public-key"),
            "authenticatorAttachment": .string("platform"),
            "response": .object([
                "clientDataJSON": .string(registration.clientDataJSON.base64URLEncodedString()),
                "attestationObject": .string(registration.attestationObject.base64URLEncodedString()),
                "transports": .array([.string("internal"), .string("hybrid")]),
            ]),
            "clientExtensionResults": .object([:]),
        ]
    }

    static func assertionResponse(_ assertion: PasskeyAssertion) -> [String: SignInJSON] {
        let id = assertion.credentialId.base64URLEncodedString()
        var response: [String: SignInJSON] = [
            "clientDataJSON": .string(assertion.clientDataJSON.base64URLEncodedString()),
            "authenticatorData": .string(assertion.authenticatorData.base64URLEncodedString()),
            "signature": .string(assertion.signature.base64URLEncodedString()),
        ]
        if let handle = assertion.userHandle { response["userHandle"] = .string(handle.base64URLEncodedString()) }
        return [
            "id": .string(id),
            "rawId": .string(id),
            "type": .string("public-key"),
            "authenticatorAttachment": .string("platform"),
            "response": .object(response),
            "clientExtensionResults": .object([:]),
        ]
    }
}

indirect enum SignInJSON: Encodable, Equatable {
    case string(String)
    case array([SignInJSON])
    case object([String: SignInJSON])

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

public enum SignInError: Error, Equatable, Sendable {
    case tooManyAttempts(retryAfterSeconds: Int?)
}

public enum SignInProblem: Sendable, Equatable {
    case codeInvalid
    case codeExpired
    case tooManyAttempts(retryAfterMinutes: Int?)
    case passkeyNeededAfterCode
    case noPasskeyHere
    case passkeyRejected
    case tryAgain
    case unreachable(code: String?)
    case keysUnavailable
    case keysUnreadable
    case storageUnavailable
    case removed

    public static func from(_ error: Error) -> SignInProblem {
        if let signIn = error as? SignInError, case let .tooManyAttempts(seconds) = signIn {
            return .tooManyAttempts(retryAfterMinutes: seconds.map { max(1, Int((Double($0) / 60).rounded(.up))) })
        }
        if error as? SignInFlowError == .passkeyNotCreated { return .passkeyNeededAfterCode }
        if error is DeviceKeyError { return .keysUnavailable }
        if let ceremony = error as? PasskeyCeremonyError {
            switch ceremony {
            case .noCredential: return .noPasskeyHere
            case .canceled, .failed: return .tryAgain
            }
        }
        if let api = error as? DeviceAPIError, case let .server(status, code, _, _) = api {
            switch code {
            case "DEVICE_SETUP_CODE_INVALID": return .codeInvalid
            case "DEVICE_SETUP_CODE_EXPIRED": return .codeExpired
            case "DEVICE_SETUP_CODE_ATTEMPTS": return .tooManyAttempts(retryAfterMinutes: nil)
            case "DEVICE_SIGN_IN_FLOW_EXPIRED": return .tryAgain
            case "DEVICE_PASSKEY_REJECTED": return .passkeyRejected
            case "DEVICE_REVOKED": return .removed
            default: return .unreachable(code: code ?? "HTTP \(status)")
            }
        }
        return .unreachable(code: nil)
    }
}

public enum ServerOrigin {
    public static let infoKey = "HimawariServerOrigin"

    public static func parse(_ text: String) -> URL? {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard
            let url = URL(string: trimmed),
            url.scheme?.lowercased() == "https",
            let host = url.host, !host.isEmpty,
            url.user == nil, url.password == nil,
            url.query == nil, url.fragment == nil,
            url.path.isEmpty || url.path == "/"
        else { return nil }
        return url
    }

    public static func bundled(_ bundle: Bundle = .main) -> URL? {
        (bundle.object(forInfoDictionaryKey: infoKey) as? String).flatMap(parse)
    }

    public static func host(_ origin: URL) -> String {
        let host = origin.host ?? origin.absoluteString
        if let port = origin.port { return "\(host):\(port)" }
        return host
    }
}
