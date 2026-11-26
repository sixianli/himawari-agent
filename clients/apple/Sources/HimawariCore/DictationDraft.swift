import Foundation

@MainActor
public final class DictationDraft {
    public private(set) var listening = false
    private var prefix = ""
    private var session = 0

    public init() {}

    public func begin(draft: String) {
        listening = true
        session += 1
        prefix = draft.isEmpty ? "" : draft + " "
    }

    public func live(_ partial: String) -> String? {
        listening ? prefix + partial : nil
    }

    public func stop(finish: () async -> String) async -> String? {
        guard listening else { return nil }
        listening = false
        let mine = session
        let prefix = prefix
        let said = await finish()
        guard mine == session, !said.isEmpty else { return nil }
        return prefix + said
    }

    public func discardPending() {
        session += 1
    }

    public func submit(draft: String, finish: () async -> String) async -> String {
        session += 1
        guard listening else { return draft }
        listening = false
        let prefix = prefix
        let said = await finish()
        return said.isEmpty ? draft : prefix + said
    }
}
