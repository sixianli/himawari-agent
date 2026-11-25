import HimawariCore
import HimawariDesign
import SwiftUI

struct AnswerText: View {
    let text: String
    var streaming = false
    var muted = false
    var copyCode: (String) -> Void = { _ in }
    var codeMenu: (String) -> MessageMenuActions? = { _ in nil }

    private static let voice = DesignTokens.TypeScale.answer.with(face: .himawari)

    var body: some View {
        let blocks = AnswerMarkdown.blocks(text, streaming: streaming)
        VStack(alignment: .leading, spacing: DesignTokens.Chat.answerBlockGap) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                view(for: block, trailingDot: streaming && index == blocks.count - 1)
            }
            if streaming, blocks.isEmpty || !Self.carriesDot(blocks.last) {
                StreamingDot.text
            }
        }
        .foregroundStyle(muted ? Color.hmMuted : Color.hmText)
        .tint(Color.hmLink)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textRenderer(InlineCodeRenderer())
        #if os(macOS)
        .textSelection(.enabled)
        #endif
    }

    private static func carriesDot(_ block: AnswerBlock?) -> Bool {
        switch block {
        case .paragraph, .heading: true
        default: false
        }
    }

    static func inline(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
        var linked = AnswerLinks.linkingBareURLs(parsed)
        for run in linked.runs where run.link != nil {
            linked[run.range].underlineStyle = .single
        }
        return linked
    }

    static func styled(_ source: String) -> Text {
        let attributed = inline(source)
        var pieces: [Text] = []
        for run in attributed.runs {
            let piece = Text(AttributedString(attributed[run.range]))
            if run.inlinePresentationIntent?.contains(.code) == true {
                pieces.append(Text("\u{2009}\(piece.customAttribute(InlineCodeMark()))\u{2009}"))
            } else {
                pieces.append(piece)
            }
        }
        return pieces.reduce(Text(verbatim: "")) { Text("\($0)\($1)") }
    }

    private func line(_ source: String, dot: Bool) -> Text {
        let body = Self.styled(source)
        return dot ? Text("\(body) \(StreamingDot.text)") : body
    }

    @ViewBuilder
    private func view(for block: AnswerBlock, trailingDot: Bool) -> some View {
        switch block {
        case let .paragraph(source):
            line(source, dot: trailingDot)
                .hmType(Self.voice)
        case let .heading(_, source):
            line(source, dot: trailingDot)
                .hmType(Self.voice)
                .fontWeight(.semibold)
                .accessibilityAddTraits(.isHeader)
        case let .bullets(items):
            list(items.map { ("•", $0) })
        case let .numbered(start, items):
            list(items.enumerated().map { ("\(start + $0.offset).", $0.element) })
        case let .quote(source):
            HStack(alignment: .top, spacing: DesignTokens.Chat.quoteGap) {
                Capsule()
                    .fill(Color.hmSeparator)
                    .frame(width: DesignTokens.Chat.quoteBar)
                Self.styled(source)
                    .hmType(Self.voice)
                    .foregroundStyle(Color.hmMuted)
            }
            .fixedSize(horizontal: false, vertical: true)
        case let .code(language, source):
            AnswerCodeBlock(language: language, code: source, copy: copyCode)
                .messageMenu(codeMenu(source))
        case let .table(header, rows):
            AnswerTable(header: header, rows: rows)
        case .rule:
            Divider()
                .overlay(Color.hmSeparator)
        }
    }

    private func list(_ items: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: DesignTokens.Chat.listMarkerGap) {
                    Text(verbatim: item.0)
                        .hmType(Self.voice)
                    Self.styled(item.1)
                        .hmType(Self.voice)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.leading, DesignTokens.Chat.listIndent)
    }
}

struct AnswerTable: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            grid
            ScrollView(.horizontal) { grid.fixedSize(horizontal: true, vertical: false) }
                .scrollIndicators(.hidden)
        }
    }

    private var grid: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                    cellView(cell)
                        .fontWeight(.semibold)
                        .background { Rectangle().fill(Color.hmFill) }
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Divider().overlay(Color.hmSeparator).gridCellUnsizedAxes(.horizontal)
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                        cellView(cell)
                    }
                }
            }
        }
        .himawariCard(padding: EdgeInsets())
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.card, style: .continuous))
    }

    private func cellView(_ source: String) -> some View {
        AnswerText.styled(source)
            .hmType(DesignTokens.TypeScale.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, DesignTokens.Chat.tableCellPaddingVertical)
            .padding(.horizontal, DesignTokens.Chat.tableCellPaddingHorizontal)
    }
}

struct InlineCodeMark: TextAttribute {}

struct InlineCodeRenderer: TextRenderer {
    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        for line in layout {
            for run in line where run[InlineCodeMark.self] != nil {
                let bounds = run.typographicBounds.rect.insetBy(dx: -DesignTokens.Chat.inlineCodePadding, dy: 0)
                context.fill(
                    Path(roundedRect: bounds, cornerRadius: DesignTokens.Chat.inlineCodeRadius, style: .continuous),
                    with: .color(Color.hmFill)
                )
            }
            for run in line {
                context.draw(run)
            }
        }
    }
}

enum StreamingDot {
    static var text: Text {
        Text(Image(size: CGSize(width: DesignTokens.Size.streamingDot, height: DesignTokens.Size.streamingDot)) { context in
            context.fill(Path(ellipseIn: CGRect(x: 0, y: 0, width: DesignTokens.Size.streamingDot, height: DesignTokens.Size.streamingDot)), with: .color(DesignTokens.Colors.streamingDot.color))
        })
    }
}
