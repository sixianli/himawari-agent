import Foundation

public enum PushSlot: Hashable, Sendable {
    case alert
    case backgroundWorkStart
    case backgroundWork(String)
}

public struct PushRegistrationRequest: Encodable, Sendable, Equatable {
    public let pushType: String
    public let activityKind: String?
    public let activityRef: String?
    public let token: String
    public let environment: String
    public let topic: String
    public let locale: String

    public init(token: String, environment: String, topic: String, locale: String) {
        self.init(slot: .alert, token: token, environment: environment, topic: topic, locale: locale)
    }

    public init(slot: PushSlot, token: String, environment: String, topic: String, locale: String) {
        switch slot {
        case .alert:
            pushType = "alert"
            activityKind = nil
            activityRef = nil
        case .backgroundWorkStart:
            pushType = "liveactivity"
            activityKind = "background_work"
            activityRef = ""
        case let .backgroundWork(subthreadId):
            pushType = "liveactivity"
            activityKind = "background_work"
            activityRef = subthreadId
        }
        self.token = token
        self.environment = environment
        self.topic = topic
        self.locale = locale
    }
}

public protocol PushRegistrationTransport: Sendable {
    func registerPush(_ request: PushRegistrationRequest) async throws -> Bool
}

extension DeviceAPI: PushRegistrationTransport {
    public func registerPush(_ request: PushRegistrationRequest) async throws -> Bool {
        do {
            _ = try await http.send(DeviceRequest(method: "POST", path: "push/register", body: try JSONEncoder().encode(request)))
            return true
        } catch let DeviceAPIError.server(status, _, _, _) where status == 503 || status == 403 {
            return false
        }
    }
}

public enum PushRegistrationValues {
    public static let maxTokenBytes = 256

    public static func tokenText(_ token: Data) -> String? {
        guard !token.isEmpty, token.count <= maxTokenBytes else { return nil }
        return token.map { String(format: "%02x", $0) }.joined()
    }

    public static func locale(preferred: [String]) -> String {
        let first = preferred.first?.lowercased() ?? "en"
        if first.hasPrefix("ja") { return "ja" }
        if first.hasPrefix("zh") { return "zh-CN" }
        return "en"
    }

    public static func environment(debugBuild: Bool) -> String {
        debugBuild ? "development" : "production"
    }
}

public struct PushRegistrationContext: Sendable {
    public let environment: String
    public let topic: String
    public let preferredLanguages: @Sendable () -> [String]

    public init(environment: String, topic: String, preferredLanguages: @escaping @Sendable () -> [String]) {
        self.environment = environment
        self.topic = topic
        self.preferredLanguages = preferredLanguages
    }
}

public actor PushTokenSync {
    private let transport: any PushRegistrationTransport
    private let context: PushRegistrationContext
    private var tokens: [PushSlot: String] = [:]
    private var sent: [PushSlot: PushRegistrationRequest] = [:]
    private var inFlight: [PushSlot: PushRegistrationRequest] = [:]
    private var ready = false
    private var generation = 0

    public init(transport: any PushRegistrationTransport, context: PushRegistrationContext) {
        self.transport = transport
        self.context = context
    }

    public func tokenArrived(_ data: Data, for slot: PushSlot = .alert) async {
        guard let text = PushRegistrationValues.tokenText(data) else { return }
        tokens[slot] = text
        await flush(slot)
    }

    public func activityEnded(_ slot: PushSlot) {
        tokens[slot] = nil
        sent[slot] = nil
        inFlight[slot] = nil
    }

    public func deviceReady() async {
        ready = true
        for slot in tokens.keys.sorted(by: { "\($0)" < "\($1)" }) {
            await flush(slot)
        }
    }

    public func deviceGone() {
        ready = false
        sent = [:]
        inFlight = [:]
        generation += 1
    }

    private func flush(_ slot: PushSlot) async {
        guard ready, let token = tokens[slot] else { return }
        let request = PushRegistrationRequest(
            slot: slot,
            token: token,
            environment: context.environment,
            topic: context.topic,
            locale: PushRegistrationValues.locale(preferred: context.preferredLanguages())
        )
        guard request != sent[slot], request != inFlight[slot] else { return }
        let started = generation
        inFlight[slot] = request
        let accepted = (try? await transport.registerPush(request)) == true
        guard started == generation, inFlight[slot] == request else { return }
        inFlight[slot] = nil
        if accepted { sent[slot] = request }
    }
}
