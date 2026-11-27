import Foundation
import HimawariCore
import Observation

public struct OwnerPreferences: Decodable, Sendable, Equatable {
    public init(name: String?, locale: String? = nil, accent: String? = nil, theme: String? = nil, modelRef: String?, thinkingLevel: String?, revision: Int) {
        self.name = name
        self.locale = locale
        self.accent = accent
        self.theme = theme
        self.modelRef = modelRef
        self.thinkingLevel = thinkingLevel
        self.revision = revision
    }

    public let name: String?
    public let locale: String?
    public let accent: String?
    public let theme: String?
    public let modelRef: String?
    public let thinkingLevel: String?
    public let revision: Int
}

@MainActor
@Observable
public final class PersonalStore {
    public enum Phase: Equatable {
        case loading
        case loaded
        case unavailable
    }

    public static let nameLimit = 40

    public private(set) var phase: Phase = .loading
    public private(set) var preferences: OwnerPreferences?
    public private(set) var models: ChatModels?

    @ObservationIgnored private let gateway: ManageGateway
    @ObservationIgnored private let loadModels: @Sendable () async -> ChatModels?

    public init(gateway: ManageGateway, loadModels: @escaping @Sendable () async -> ChatModels?) {
        self.gateway = gateway
        self.loadModels = loadModels
    }

    init(gateway: ManageGateway, preferences: OwnerPreferences, models: ChatModels?) {
        self.gateway = gateway
        self.preferences = preferences
        self.models = models
        phase = .loaded
        loadModels = { models }
    }

    public func load() async {
        async let listed = loadModels()
        do {
            let data = try await gateway.read(.v2, "owner.preferences.read")
            preferences = try JSONDecoder().decode(Snapshot<OwnerPreferences>.self, from: data).payload
            phase = .loaded
        } catch {
            if preferences == nil { phase = .unavailable }
        }
        if let fresh = await listed { models = fresh }
    }

    public var name: String? {
        preferences?.name.flatMap { $0.isEmpty ? nil : $0 }
    }

    public var canChooseModel: Bool {
        guard preferences != nil, let models, !models.options.isEmpty else { return false }
        return models.options.count > 1 || (chosenModel?.thinkingLevels.count ?? 0) > 1
    }

    public var chosenModel: ChatModel? {
        guard let models else { return nil }
        return models.options.first { $0.ref == preferences?.modelRef }
            ?? models.options.first { $0.ref == models.defaultRef }
    }

    public func thinkingLevel(for model: ChatModel) -> String? {
        if model.ref == preferences?.modelRef, let saved = preferences?.thinkingLevel, model.thinkingLevels.contains(saved) {
            return saved
        }
        return model.defaultThinkingLevel
    }

    public static func cleanName(_ text: String) -> String? {
        let trimmed = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(nameLimit))
        return trimmed.isEmpty ? nil : trimmed
    }

    public func setName(_ text: String, reason: String) async throws {
        try await save(reason: reason) { fields in
            fields["name"] = Self.cleanName(text).map(JSONValue.string) ?? .null
        }
    }

    public func setModel(_ model: ChatModel, thinkingLevel: String?, reason: String) async throws {
        let level = thinkingLevel.flatMap { model.thinkingLevels.contains($0) ? $0 : nil } ?? model.defaultThinkingLevel
        try await save(reason: reason) { fields in
            fields["modelRef"] = .string(model.ref)
            fields["thinkingLevel"] = level.map(JSONValue.string) ?? .null
        }
    }

    private func save(reason: String, change: (inout [String: JSONValue]) -> Void) async throws {
        guard let current = preferences else { return }
        func value(_ text: String?) -> JSONValue { text.map(JSONValue.string) ?? .null }
        var fields: [String: JSONValue] = [
            "name": value(current.name),
            "locale": value(current.locale),
            "accent": value(current.accent),
            "theme": value(current.theme),
            "modelRef": value(current.modelRef),
            "thinkingLevel": value(current.thinkingLevel),
            "expectedRevision": .number(Double(current.revision)),
        ]
        change(&fields)
        do {
            _ = try await gateway.command(
                .v2,
                "owner.preferences.set",
                payload: .object(fields),
                options: ManageCommandOptions(risk: "medium", confirmReason: reason)
            )
            await load()
        } catch {
            await load()
            throw error
        }
    }
}
