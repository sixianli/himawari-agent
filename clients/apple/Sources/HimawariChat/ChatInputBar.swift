import HimawariCore
import HimawariDesign
import SwiftUI

struct ChatInputBar: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let sending: Bool
    var hasAttachments = false
    var voice = false
    var dictating = false
    var offline = false
    var openAttach: (() -> Void)?
    var stop: (() -> Void)?
    var startTalk: (() -> Void)?
    var toggleDictation: () -> Void = {}
    let send: () -> Void

    private static let inset = (DesignTokens.Size.composerHeight - DesignTokens.Size.composerButton) / 2

    private var canSend: Bool {
        !sending && (hasAttachments || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: DesignTokens.Size.composerGap) {
            if let openAttach {
                circle(.plus, label: L.text("attach.add"), fill: Color.hmFill, foreground: Color.hmText, action: openAttach)
            }
            middle
            if voice {
                circle(.microphone, label: L.text(dictating ? "chat.dictate.stop" : "chat.dictate"), fill: dictating ? Color.hmText : Color.hmFill, foreground: dictating ? Color.hmOnText : Color.hmText, action: toggleDictation)
                    .accessibilityIdentifier("chat.microphone")
            }
            if let stop, !canSend {
                circle(.playerStop, label: L.text("chat.stop"), fill: Color.hmText, foreground: Color.hmOnText, action: stop)
                    .transition(.scale.combined(with: .opacity))
            } else if canSend {
                circle(.arrowUp, label: L.text("chat.send"), fill: Color.hmText, foreground: Color.hmOnText, action: send)
                    .accessibilityIdentifier("chat.send")
                    .transition(.scale.combined(with: .opacity))
            } else {
                circle(.voiceWave, label: L.text("chat.talk"), fill: Color.hmText, foreground: Color.hmOnText) { startTalk?() }
                    .allowsHitTesting(startTalk != nil)
            }
        }
        .padding(.horizontal, Self.inset)
        .padding(.vertical, Self.inset)
        .frame(minHeight: DesignTokens.Size.composerHeight)
        .animation(.easeInOut(duration: 0.15), value: canSend)
        .animation(.easeInOut(duration: 0.15), value: stop == nil)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.composer, style: .continuous))
        .keepsKeyboardOnTap()
    }

    private var middle: some View {
        TextField(L.text(offline ? "chat.offline" : "chat.input.placeholder"), text: $text, axis: .vertical)
            .hmType(DesignTokens.TypeScale.body)
            .foregroundStyle(Color.hmText)
            .lineLimit(1...6)
            .accessibilityIdentifier("chat.input")
            .focused(focused)
            .submitLabel(.send)
            .onSubmit(send)
            .padding(.horizontal, DesignTokens.Size.composerPadding)
            .frame(minHeight: DesignTokens.Size.composerButton)
    }

    private func circle(_ icon: IconName, label: String, fill: Color, foreground: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(icon, size: DesignTokens.IconSize.glassButton)
                .foregroundStyle(foreground)
                .frame(width: DesignTokens.Size.composerButton, height: DesignTokens.Size.composerButton)
                .background(fill, in: Circle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(Text(label))
    }
}
