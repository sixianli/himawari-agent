import Foundation

public enum ConnectionOutcome: Equatable, Sendable {
    case connected
    case denied
    case failed
    case cancelled
}

enum ConnectionAuthorization {
    static let startPath = "connections/authorization"
    static let completePath = "connections/authorization/complete"

    @MainActor
    static func run(
        gateway: ManageGateway,
        connection: String,
        callbackScheme: String,
        callbackHost: String,
        signIn: @MainActor (URL, String) async throws -> URL?
    ) async -> ConnectionOutcome {
        struct Started: Decodable {
            let kind: String
            let authorizationUrl: String?
        }
        struct Finished: Decodable {
            let outcome: String
        }
        do {
            let startedData = try await gateway.post(startPath, body: ["connection": .string(connection), "callbackScheme": .string(callbackScheme)])
            let started = try JSONDecoder().decode(Started.self, from: startedData)
            guard started.kind == "browser", let page = started.authorizationUrl.flatMap(URL.init(string:)) else { return .failed }
            guard let returned = try await signIn(page, callbackScheme) else { return .cancelled }
            guard let state = state(in: returned, scheme: callbackScheme, host: callbackHost) else { return .failed }
            let finishedData = try await gateway.post(completePath, body: ["state": .string(state)])
            switch try JSONDecoder().decode(Finished.self, from: finishedData).outcome {
            case "connected": return .connected
            case "denied": return .denied
            default: return .failed
            }
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .failed
        }
    }

    static func state(in url: URL, scheme: String, host: String) -> String? {
        guard url.scheme?.lowercased() == scheme, url.host() == host,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        return items.first { $0.name == "state" }?.value.flatMap { $0.isEmpty ? nil : $0 }
    }
}
