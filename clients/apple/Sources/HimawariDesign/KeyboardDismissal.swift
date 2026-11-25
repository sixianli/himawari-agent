import SwiftUI

#if os(iOS)
import UIKit

@MainActor
final class KeyboardKeepZones {
    static let shared = KeyboardKeepZones()
    private var zones: [UUID: CGRect] = [:]

    func set(_ id: UUID, _ frame: CGRect?) {
        zones[id] = frame
    }

    func contains(_ point: CGPoint) -> Bool {
        zones.values.contains { $0.contains(point) }
    }
}

final class OutsideTapRecognizer: UITapGestureRecognizer, UIGestureRecognizerDelegate {
    static func make() -> OutsideTapRecognizer {
        let recognizer = OutsideTapRecognizer(target: nil, action: nil)
        recognizer.addTarget(recognizer, action: #selector(dismiss))
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesBegan = false
        recognizer.delaysTouchesEnded = false
        recognizer.delegate = recognizer
        return recognizer
    }

    @objc private func dismiss() {
        view?.endEditing(true)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let window = view else { return false }
        if KeyboardKeepZones.shared.contains(touch.location(in: window)) { return false }
        var current = touch.view
        while let candidate = current {
            if candidate is UITextView || candidate is UITextField { return false }
            current = candidate.superview
        }
        return true
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}

private final class RecognizerHost: UIView {
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard let window, !(window.gestureRecognizers ?? []).contains(where: { $0 is OutsideTapRecognizer }) else { return }
        window.addGestureRecognizer(OutsideTapRecognizer.make())
    }
}

private struct RecognizerInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = RecognizerHost()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}

private struct KeepsKeyboard: ViewModifier {
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { KeyboardKeepZones.shared.set(id, $0) }
            .onDisappear { KeyboardKeepZones.shared.set(id, nil) }
    }
}
#endif

extension View {
    public func dismissesKeyboardOnOutsideTap() -> some View {
        #if os(iOS)
        background(RecognizerInstaller().allowsHitTesting(false))
        #else
        self
        #endif
    }

    public func keepsKeyboardOnTap() -> some View {
        #if os(iOS)
        modifier(KeepsKeyboard())
        #else
        self
        #endif
    }
}
