import HimawariCore
import HimawariDesign
import SwiftUI

struct SearchPage: View {
    @Bindable var model: SearchModel
    let close: () -> Void
    let openSource: (SearchBasis) -> Void
    @State private var fullText: String?
    @State private var shortHeight: CGFloat = 0
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .bottom) {
            ScrollView {
                VStack(alignment: .leading, spacing: DesignTokens.Search.gap) {
                    ScreenTitle(Text(L.text("search.title")))
                        .padding(.horizontal, DesignTokens.Search.titleInset)
                    content
                }
                .padding(.top, DesignTokens.Search.paddingTop)
                .padding(.horizontal, DesignTokens.Size.pagePaddingX)
                .padding(.bottom, DesignTokens.Search.paddingBottom)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            EdgeFade(.bottom, height: DesignTokens.Search.fadeHeight, solid: 0.4)
            bar
                .padding(.horizontal, DesignTokens.Size.pagePaddingX)
                .padding(.bottom, DesignTokens.Search.barBottom)
        }
        .himawariScreenBackground()
        .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let asking = model.asking {
            question(asking)
        } else if let answer = model.answer, answer.state != .suggestions {
            VStack(alignment: .leading, spacing: DesignTokens.Search.answerGap) {
                if let query = answer.query { question(query) }
                if let text = answer.shownAnswer {
                    answerText(text)
                } else if let message = answer.notFoundText, !message.isEmpty {
                    Text(message)
                        .hmType(DesignTokens.TypeScale.secondary)
                        .foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, DesignTokens.Search.answerInset)
                }
                if !answer.shownBasis.isEmpty {
                    basisCard(answer.shownBasis)
                }
            }
        } else if model.failed {
            Text(L.text("search.failed"))
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmMuted)
                .padding(.horizontal, DesignTokens.Search.titleInset)
        } else if !model.suggestions.isEmpty {
            suggestionsCard
        }
    }

    @ViewBuilder
    private func answerText(_ text: String) -> some View {
        let top = DesignTokens.TypeScale.todayTop
        let short = shortHeight <= (top.lineHeight ?? top.size * 1.5) * 3 + 1
        Button { fullText = text } label: {
            Text(text)
                .hmType(short ? top : DesignTokens.TypeScale.body)
                .lineLimit(short ? nil : 6)
                .foregroundStyle(Color.hmText)
                .multilineTextAlignment(.leading)
                .padding(.horizontal, DesignTokens.Search.answerInset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(alignment: .topLeading) {
                    Text(text)
                        .hmType(top)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, DesignTokens.Search.answerInset)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { shortHeight = $0 }
                        .hidden()
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sheet(isPresented: Binding(get: { fullText != nil }, set: { if !$0 { fullText = nil } })) {
            ScrollView {
                Text(fullText ?? "")
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                    .padding(DesignTokens.Size.pagePaddingX)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .himawariScreenBackground()
            .presentationDetents([.medium, .large])
        }
    }

    private var suggestionsCard: some View {
        VStack(spacing: 0) {
            ForEach(Array(model.suggestions.enumerated()), id: \.offset) { index, text in
                Button {
                    Task { await model.ask(text) }
                } label: {
                    Text(text)
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, minHeight: DesignTokens.Search.askMinHeight, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if index < model.suggestions.count - 1 { RowSeparator() }
            }
        }
        .himawariCard(padding: EdgeInsets(top: 0, leading: DesignTokens.Search.askInsetX, bottom: 0, trailing: DesignTokens.Search.askInsetX))
    }

    private func question(_ text: String) -> some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.bubble)
            .foregroundStyle(Color.hmText)
            .padding(.horizontal, DesignTokens.Search.bubblePaddingX)
            .padding(.vertical, DesignTokens.Search.bubblePaddingY)
            .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Search.bubbleRadius, style: .continuous))
            .frame(maxWidth: DesignTokens.Search.bubbleMaxWidth, alignment: .trailing)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private func basisCard(_ basis: [SearchBasis]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(basis.enumerated()), id: \.element.id) { index, item in
                Button { openSource(item) } label: {
                    VStack(alignment: .leading, spacing: DesignTokens.Search.basisGap) {
                        if index == 0 {
                            Text(L.text("search.basis"))
                                .hmType(DesignTokens.TypeScale.caption)
                                .foregroundStyle(Color.hmMuted)
                        }
                        Text(item.label)
                            .hmType(DesignTokens.TypeScale.secondary)
                            .foregroundStyle(Color.hmText)
                            .multilineTextAlignment(.leading)
                    }
                    .frame(maxWidth: .infinity, minHeight: DesignTokens.Search.basisMinHeight, alignment: .leading)
                    .padding(.vertical, DesignTokens.Search.basisPaddingY)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if index < basis.count - 1 { RowSeparator() }
            }
        }
        .himawariCard(padding: EdgeInsets(top: 0, leading: DesignTokens.Search.askInsetX, bottom: 0, trailing: DesignTokens.Search.askInsetX))
    }

    private var bar: some View {
        HStack(spacing: DesignTokens.Search.barGap) {
            GlassCircleButton(Text(L.text("search.back")), size: DesignTokens.Search.backSize, action: close) {
                Icon(.sun, size: DesignTokens.IconSize.glassButton)
            }
            HStack(spacing: DesignTokens.Search.fieldGap) {
                Icon(.search, size: DesignTokens.IconSize.glassButton)
                    .foregroundStyle(Color.hmMuted)
                TextField(L.text("search.placeholder"), text: $model.text)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                    .focused($focused)
                    .submitLabel(.search)
                    .onSubmit { Task { await model.submit() } }
            }
            .padding(.horizontal, DesignTokens.Search.fieldPaddingX)
            .frame(height: DesignTokens.Search.fieldHeight)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: DesignTokens.Search.fieldRadius, style: .continuous))
        }
    }
}
