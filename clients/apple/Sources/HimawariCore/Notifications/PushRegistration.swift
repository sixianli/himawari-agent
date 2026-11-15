import Foundation

public struct PushRegistrationRequest: Encodable, Sendable, Equatable {
    public let pushType: String
    public let token: String
    public let environment: String
    public let topic: String
    public let locale: String

    public init(token: String, environment: String, topic: String, locale: String) {
        pushType = "alert"
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
    private var token: String?
    private var sent: PushRegistrationRequest?
    private var ready = false

    public init(transport: any PushRegistrationTransport, context: PushRegistrationContext) {
        self.transport = transport
        self.context = context
    }

    public func tokenArrived(_ data: Data) async {
        guard let text = PushRegistrationValues.tokenText(data) else { return }
        token = text
        await flush()
    }

    public func deviceReady() async {
        ready = true
        await flush()
    }

    public func deviceGone() {
        ready = false
        sent = nil
    }

    private func flush() async {
        guard ready, let token else { return }
        let request = PushRegistrationRequest(
            token: token,
            environment: context.environment,
            topic: context.topic,
            locale: PushRegistrationValues.locale(preferred: context.preferredLanguages())
        )
        guard request != sent else { return }
        if (try? await transport.registerPush(request)) == true { sent = request }
    }
}
