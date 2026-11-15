import Foundation
import HimawariCore
import Observation

public protocol SearchSource: Sendable {
    func ask(_ question: String?) async throws -> SearchAnswer
}

@MainActor
@Observable
public final class SearchModel {
    public private(set) var suggestions: [String] = []
    public private(set) var answer: SearchAnswer?
    public private(set) var asking: String?
    public private(set) var failed = false
    public var text = ""

    @ObservationIgnored private let source: (any SearchSource)?

    public init(source: (any SearchSource)?) {
        self.source = source
    }

    init(suggestions: [String], answer: SearchAnswer? = nil, text: String = "") {
        source = nil
        self.suggestions = suggestions
        self.answer = answer
        self.text = text
    }

    public var available: Bool { source != nil }

    public func load() async {
        guard let source, suggestions.isEmpty else { return }
        do {
            suggestions = try await source.ask(nil).asks
        } catch {
            suggestions = []
        }
    }

    public func submit() async {
        guard let question = SearchQuestion.trimmed(text) else { return }
        await ask(question)
    }

    public func ask(_ question: String) async {
        guard let source, asking == nil else { return }
        text = ""
        asking = question
        defer { asking = nil }
        do {
            answer = try await source.ask(question)
            failed = false
        } catch {
            failed = true
        }
    }

    public func reset() {
        answer = nil
        failed = false
        text = ""
    }
}
