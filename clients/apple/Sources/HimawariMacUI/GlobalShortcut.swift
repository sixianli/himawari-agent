#if os(macOS)
import AppKit
import Carbon.HIToolbox
import HimawariCore

@MainActor
final class GlobalShortcut {
    enum State: Equatable {
        case active(KeyShortcut)
        case taken(KeyShortcut)
    }

    private(set) var state: State?
    private var reference: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let fired: @MainActor () -> Void
    private static let signature: OSType = 0x484D5752
    private static weak var current: GlobalShortcut?

    init(fired: @escaping @MainActor () -> Void) {
        self.fired = fired
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            MainActor.assumeIsolated { GlobalShortcut.current?.fired() }
            return noErr
        }, 1, &spec, nil, &handler)
        Self.current = self
    }

    @discardableResult
    func register(_ shortcut: KeyShortcut) -> State {
        unregister()
        var hotKey: EventHotKeyRef?
        let identifier = EventHotKeyID(signature: Self.signature, id: 1)
        let status = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, identifier, GetApplicationEventTarget(), 0, &hotKey)
        if status == noErr, let hotKey {
            reference = hotKey
            state = .active(shortcut)
        } else {
            state = .taken(shortcut)
        }
        return state ?? .taken(shortcut)
    }

    func unregister() {
        if let reference { UnregisterEventHotKey(reference) }
        reference = nil
    }

    var activeShortcut: KeyShortcut? {
        if case let .active(shortcut) = state { return shortcut }
        return nil
    }

    static func shortcut(from event: NSEvent) -> KeyShortcut? {
        var modifiers: UInt32 = 0
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.contains(.option) { modifiers |= KeyShortcut.optionModifier }
        if flags.contains(.command) { modifiers |= KeyShortcut.commandModifier }
        if flags.contains(.control) { modifiers |= KeyShortcut.controlModifier }
        if flags.contains(.shift) { modifiers |= KeyShortcut.shiftModifier }
        let key = event.keyCode == UInt16(kVK_Space) ? "space" : (event.charactersIgnoringModifiers ?? "").uppercased()
        guard !key.isEmpty else { return nil }
        return KeyShortcut(keyCode: UInt32(event.keyCode), modifiers: modifiers, key: key)
    }

    static func label(_ shortcut: KeyShortcut) -> String {
        let key = shortcut.key == "space" ? L.text("key.space") : shortcut.key
        return "\(shortcut.modifierSymbols) \(key)"
    }
}
#endif
