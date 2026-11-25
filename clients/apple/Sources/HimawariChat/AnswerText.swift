import HimawariCore
import HimawariDesign
import SwiftUI

struct AnswerText: View {
    let text: String
    var streaming = false
    var muted = false

    private static let voice = DesignTokens.TypeScale.answer.with(face: .himawari)
    private static let small = DesignTokens.TypeScale.secondary

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
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    private static func carriesDot(_ block: AnswerBlock?) -> Bool {
        switch block {
        case .paragraph, .heading: true
        default: false
        }
    }

    static func inline(_ source: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
    }

    private func line(_ source: String, dot: Bool) -> Text {
        let body = Text(Self.inline(source))
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
                Text(Self.inline(source))
                    .hmType(Self.voice)
                    .foregroundStyle(Color.hmMuted)
            }
            .fixedSize(horizontal: false, vertical: true)
        case let .code(_, source):
            ScrollView(.horizontal) {
                Text(verbatim: source)
                    .hmType(Self.small, design: .monospaced)
                    .padding(DesignTokens.Chat.codePadding)
            }
            .scrollIndicators(.hidden)
            .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.segment, style: .continuous))
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
                    Text(Self.inline(item.1))
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
        Text(AnswerText.inline(source))
            .hmType(DesignTokens.TypeScale.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, DesignTokens.Chat.tableCellPaddingVertical)
            .padding(.horizontal, DesignTokens.Chat.tableCellPaddingHorizontal)
    }
}

enum StreamingDot {
    static var text: Text {
        Text(Image(size: CGSize(width: DesignTokens.Size.streamingDot, height: DesignTokens.Size.streamingDot)) { context in
            context.fill(Path(ellipseIn: CGRect(x: 0, y: 0, width: DesignTokens.Size.streamingDot, height: DesignTokens.Size.streamingDot)), with: .color(DesignTokens.Colors.streamingDot.color))
        })
    }
}
