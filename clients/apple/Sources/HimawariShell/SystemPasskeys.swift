#if canImport(AuthenticationServices)
import AuthenticationServices
import HimawariCore
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct SystemPasskeys: PasskeyCeremony {
    public typealias Anchor = @MainActor @Sendable () -> ASPresentationAnchor?

    private let anchor: Anchor

    public init(anchor: Anchor? = nil) {
        self.anchor = anchor ?? { SystemPasskeys.keyWindow() }
    }

    public func register(_ options: PasskeyRegistrationOptions) async throws -> PasskeyRegistration {
        try await Self.register(options, anchor: anchor)
    }

    public func assert(_ options: PasskeyAssertionOptions, immediatelyAvailableOnly: Bool) async throws -> PasskeyAssertion {
        try await Self.assert(options, immediatelyAvailableOnly: immediatelyAvailableOnly, anchor: anchor)
    }

    @MainActor
    private static func register(_ options: PasskeyRegistrationOptions, anchor: @escaping Anchor) async throws -> PasskeyRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.relyingParty)
        let request = provider.createCredentialRegistrationRequest(challenge: options.challenge, name: options.userName, userID: options.userId)
        request.userVerificationPreference = .required
        request.excludedCredentials = options.excluded.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        let credential = try await PasskeySession(anchor: anchor).run(request, immediatelyAvailableOnly: false)
        guard
            let registration = credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
            let attestation = registration.rawAttestationObject
        else { throw PasskeyCeremonyError.failed("registration") }
        return PasskeyRegistration(credentialId: registration.credentialID, clientDataJSON: registration.rawClientDataJSON, attestationObject: attestation)
    }

    @MainActor
    private static func assert(_ options: PasskeyAssertionOptions, immediatelyAvailableOnly: Bool, anchor: @escaping Anchor) async throws -> PasskeyAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.relyingParty)
        let request = provider.createCredentialAssertionRequest(challenge: options.challenge)
        request.userVerificationPreference = .required
        request.allowedCredentials = options.allowed.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        let credential = try await PasskeySession(anchor: anchor).run(request, immediatelyAvailableOnly: immediatelyAvailableOnly)
        guard let assertion = credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyCeremonyError.failed("assertion")
        }
        return PasskeyAssertion(
            credentialId: assertion.credentialID,
            clientDataJSON: assertion.rawClientDataJSON,
            authenticatorData: assertion.rawAuthenticatorData,
            signature: assertion.signature,
            userHandle: assertion.userID
        )
    }

    @MainActor
    public static func keyWindow() -> ASPresentationAnchor? {
        #if canImport(UIKit)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
        #elseif canImport(AppKit)
        return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first
        #endif
    }

    static func problem(_ error: Error, immediatelyAvailableOnly: Bool) -> PasskeyCeremonyError {
        guard let code = (error as? ASAuthorizationError)?.code else { return .failed(String(describing: error)) }
        switch code {
        case .canceled where immediatelyAvailableOnly, .notInteractive:
            return .noCredential
        case .canceled:
            return .canceled
        default:
            return .failed("ASAuthorizationError \(code.rawValue)")
        }
    }
}

@MainActor
private final class PasskeySession: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private let anchor: SystemPasskeys.Anchor
    private var continuation: CheckedContinuation<ASAuthorizationCredential, Error>?
    private var immediatelyAvailableOnly = false
    private var retained: PasskeySession?

    init(anchor: @escaping SystemPasskeys.Anchor) {
        self.anchor = anchor
    }

    func run(_ request: ASAuthorizationRequest, immediatelyAvailableOnly: Bool) async throws -> ASAuthorizationCredential {
        self.immediatelyAvailableOnly = immediatelyAvailableOnly
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            retained = self
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            if immediatelyAvailableOnly {
                controller.performRequests(options: .preferImmediatelyAvailableCredentials)
            } else {
                controller.performRequests()
            }
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        let credential = authorization.credential
        MainActor.assumeIsolated { finish(.success(credential)) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            finish(.failure(SystemPasskeys.problem(error, immediatelyAvailableOnly: immediatelyAvailableOnly)))
        }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor() ?? ASPresentationAnchor() }
    }

    private func finish(_ result: Result<ASAuthorizationCredential, Error>) {
        continuation?.resume(with: result)
        continuation = nil
        retained = nil
    }
}
#endif
