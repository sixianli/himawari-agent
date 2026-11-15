#if os(iOS)
import Foundation
import HimawariCore
import UIKit

@MainActor
public final class ClipboardCollector: SenseCollector {
    public let item = SenseItem.clipboard
    static let changeName = "clipboard-change-count"
    private var sink: SenseSink?
    private var observer: NSObjectProtocol?

    public init() {}

    public func authorization() async -> SenseAuthorization { .allowed }

    public func requestAuthorization() async -> SenseAuthorization { .allowed }

    public func start(_ sink: SenseSink) {
        self.sink = sink
        if sink.localStore.read(Self.changeName) == nil { remember(UIPasteboard.general.changeCount, in: sink.localStore) }
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.check() }
        }
    }

    public func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        if let sink { try? sink.localStore.write(Self.changeName, nil) }
        sink = nil
    }

    private func check() {
        guard let sink else { return }
        let pasteboard = UIPasteboard.general
        let count = pasteboard.changeCount
        let last = sink.localStore.read(Self.changeName).flatMap { String(data: $0, encoding: .utf8) }.flatMap(Int.init)
        guard count != last else { return }
        remember(count, in: sink.localStore)
        guard pasteboard.hasStrings, let text = pasteboard.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sink.record(SenseObservations.clipboard(text: text, sourceApp: nil, at: Date()))
    }

    private func remember(_ count: Int, in store: LocalStore) {
        try? store.write(Self.changeName, Data(String(count).utf8))
    }
}
#endif
