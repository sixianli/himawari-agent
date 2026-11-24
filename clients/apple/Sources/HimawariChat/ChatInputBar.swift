import HimawariCore
import HimawariDesign
import SwiftUI

struct ChatInputBar: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let sending: Bool
    var hasAttachments = false
    var voice = false
    var hold: HoldPhase?
    var dictating = false
    var openAttach: (() -> Void)?
    var toggleDictation: () -> Void = {}
    var holdChanged: (HoldEvent) -> Void = { _ in }
    let send: () -> Void

    private static let holdDelay = 0.35
    private static let inset = (DesignTokens.Size.composerHeight - DesignTokens.Size.composerButton) / 2

    private var canSend: Bool {
        !sending && (hasAttachments || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var holdEnabled: Bool {
        hold != nil || (voice && text.isEmpty && !dictating && !hasAttachments)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: DesignTokens.Size.composerGap) {
            if let openAttach, hold == nil {
                circle(.plus, label: L.text("attach.add"), fill: Color.hmFill, foreground: Color.hmText, action: openAttach)
            }
            middle
                .overlay {
                    if holdEnabled { holdArea }
                }
            if voice, hold == nil {
                circle(.microphone, label: L.text("chat.dictate"), fill: dictating ? Color.hmSpeak : Color.hmFill, foreground: dictating ? Color.hmOnText : Color.hmText, action: toggleDictation)
            }
            if hold == nil {
                if canSend {
                    circle(.arrowUp, label: L.text("chat.send"), fill: Color.hmSpeak, foreground: Color.hmOnText, action: send)
                        .transition(.scale.combined(with: .opacity))
                } else {
                    circle(.voiceWave, label: L.text("chat.talk"), fill: Color.hmSpeak, foreground: Color.hmOnText) {}
                        .allowsHitTesting(false)
                }
            }
        }
        .padding(.horizontal, Self.inset)
        .padding(.vertical, Self.inset)
        .frame(minHeight: DesignTokens.Size.composerHeight)
        .animation(.easeInOut(duration: 0.15), value: canSend)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.composer, style: .continuous))
        .keepsKeyboardOnTap()
    }

    @ViewBuilder
    private var middle: some View {
        switch hold {
        case let .listening(heard):
            Text(heard.isEmpty ? L.text("chat.hold.hint") : heard)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(heard.isEmpty ? Color.hmMuted : Color.hmText)
                .lineLimit(1...6)
                .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.composerButton, alignment: .leading)
                .padding(.horizontal, DesignTokens.Size.composerPadding)
        case .cancelling:
            HStack(spacing: DesignTokens.Chat.listMarkerGap) {
                Icon(.x, size: DesignTokens.IconSize.glassButton)
                Text(L.text("chat.hold.cancel")).hmType(DesignTokens.TypeScale.body)
            }
            .foregroundStyle(Color.hmDanger)
            .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.composerButton)
        case nil:
            TextField(L.text("chat.input.placeholder"), text: $text, axis: .vertical)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .lineLimit(1...6)
                .focused(focused)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, DesignTokens.Size.composerPadding)
                .frame(minHeight: DesignTokens.Size.composerButton)
        }
    }

    private var holdArea: some View {
        GeometryReader { proxy in
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture { focused.wrappedValue = true }
                .gesture(
                    LongPressGesture(minimumDuration: Self.holdDelay)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { value in
                            guard case let .second(true, drag) = value else { return }
                            if hold == nil {
                                holdChanged(.began)
                            } else if let drag {
                                holdChanged(.moved(outside: drag.location.y < -proxy.size.height / 2))
                            }
                        }
                        .onEnded { _ in holdChanged(.ended) }
                )
        }
    }

    private func circle(_ icon: IconName, label: String, fill: Color, foreground: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(icon, size: DesignTokens.IconSize.glassButton)
                .foregroundStyle(foreground)
                .frame(width: DesignTokens.Size.composerButton, height: DesignTokens.Size.composerButton)
                .background(fill, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}
