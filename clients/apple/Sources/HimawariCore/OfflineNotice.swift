import Foundation

@MainActor
public final class OfflineNotice {
    public static let graceSeconds: TimeInterval = 3

    public private(set) var shown = false
    private let grace: TimeInterval
    private let changed: @MainActor (Bool) -> Void
    private(set) var pending: Task<Void, Never>?
    private var connected = false

    public init(grace: TimeInterval = OfflineNotice.graceSeconds, changed: @escaping @MainActor (Bool) -> Void = { _ in }) {
        self.grace = grace
        self.changed = changed
    }

    public func connectionChanged(online: Bool) {
        connected = online
        if online {
            pending?.cancel()
            pending = nil
            show(false)
            return
        }
        guard pending == nil, !shown else { return }
        startGrace()
    }

    public func retrying() {
        guard !connected else { return }
        pending?.cancel()
        pending = nil
        show(false)
        startGrace()
    }

    private func startGrace() {
        let grace = grace
        pending = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.pending = nil
            if !self.connected { self.show(true) }
        }
    }

    private func show(_ value: Bool) {
        guard shown != value else { return }
        shown = value
        changed(value)
    }
}
