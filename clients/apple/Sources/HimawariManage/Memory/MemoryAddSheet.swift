import HimawariDesign
import SwiftUI

struct MemoryAddSheet: View {
    typealias L = ManageLayout.EditSheet

    @State private var text = ""
    @State private var saving = false
    @FocusState private var focused: Bool
    let close: () -> Void
    let save: (String) async -> Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: L.gap) {
            HStack {
                Button(action: close) {
                    Icon(.x, size: L.closeIcon)
                        .foregroundStyle(Color.hmText)
                        .frame(width: L.headerButton, height: L.headerButton)
                        .background(Color.hmFill, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(M.close))
                Spacer()
                Text(M.addMemory).hmType(DesignTokens.TypeScale.sheetTitle).foregroundStyle(Color.hmText)
                Spacer()
                Button {
                    saving = true
                    Task {
                        if await save(trimmed) { close() }
                        saving = false
                    }
                } label: {
                    Text(M.save)
                        .hmType(L.save)
                        .foregroundStyle(Color.hmSun)
                        .frame(width: L.headerButton, height: L.headerButton, alignment: .trailing)
                }
                .buttonStyle(.plain)
                .disabled(trimmed.isEmpty || saving)
            }
            TextField(M.addPlaceholder, text: $text, axis: .vertical)
                .hmType(L.text)
                .foregroundStyle(Color.hmText)
                .tint(Color.hmSunBright)
                .focused($focused)
                .padding(.vertical, L.cardPaddingVertical)
                .padding(.horizontal, L.cardPaddingHorizontal)
                .frame(maxWidth: .infinity, minHeight: L.cardMinHeight, alignment: .topLeading)
                .himawariCard(padding: EdgeInsets())
            Spacer(minLength: 0)
        }
        .padding(.top, DesignTokens.Size.sheetPaddingTop)
        .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
        .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        .background(Color.hmBackground)
        .onAppear { focused = true }
    }
}
