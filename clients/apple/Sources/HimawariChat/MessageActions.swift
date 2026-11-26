import HimawariCore
import HimawariDesign
import SwiftUI
#if canImport(UIKit)
import SafariServices
import UIKit
#endif

struct MessageMenuActions {
    var reply: (() -> Void)?
    let copy: () -> Void
    let select: () -> Void
}

extension View {
    @ViewBuilder
    func messageMenu(_ actions: MessageMenuActions?) -> some View {
        #if os(iOS)
        if let actions {
            contextMenu {
                if let reply = actions.reply {
                    Button(action: reply) { Label(L.text("chat.menu.reply"), systemImage: "arrowshape.turn.up.left") }
                }
                Button(action: actions.copy) { Label(L.text("chat.menu.copy"), systemImage: "doc.on.doc") }
                Button(action: actions.select) { Label(L.text("chat.menu.select"), systemImage: "text.cursor") }
            }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

struct SelectableMessage: Identifiable, Equatable {
    let id: String
    let text: String
    let fromAgent: Bool
}

struct CopiedToast: View {
    var body: some View {
        Text(L.text("chat.copied"))
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(Color.hmText)
            .padding(.horizontal, DesignTokens.Chat.copiedToastPaddingHorizontal)
            .padding(.vertical, DesignTokens.Chat.copiedToastPaddingVertical)
            .glassEffect(.regular, in: Capsule())
            .accessibilityAddTraits(.isStaticText)
    }
}

#if os(iOS)
enum Pasteboard {
    @MainActor
    static func copy(_ text: String) {
        UIPasteboard.general.string = text
    }
}

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

struct SafariLink: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

struct SelectTextSheet: View {
    let message: SelectableMessage
    let close: () -> Void

    var body: some View {
        NavigationStack {
            SelectableTextView(attributed: SelectableText.attributed(message))
                .padding(.horizontal, DesignTokens.Size.chatPaddingX)
                .navigationTitle(L.text("chat.select.title"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(L.text("chat.select.done"), action: close)
                    }
                }
                .himawariScreenBackground()
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

struct SelectableTextView: UIViewRepresentable {
    let attributed: NSAttributedString

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.adjustsFontForContentSizeCategory = true
        view.dataDetectorTypes = []
        view.textContainerInset = UIEdgeInsets(top: DesignTokens.Chat.codePadding, left: 0, bottom: DesignTokens.Chat.codePadding, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.linkTextAttributes = [.foregroundColor: UIColor(Color.hmLink), .underlineStyle: NSUnderlineStyle.single.rawValue]
        view.attributedText = attributed
        DispatchQueue.main.async {
            view.becomeFirstResponder()
            view.selectedRange = NSRange(location: 0, length: attributed.length)
        }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {}
}

enum SelectableText {
    @MainActor
    static func attributed(_ message: SelectableMessage) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let size = message.fromAgent ? DesignTokens.TypeScale.answer.size : DesignTokens.TypeScale.bubble.size
        let body = scaled(UIFont.systemFont(ofSize: size))
        let bold = scaled(UIFont.systemFont(ofSize: size, weight: .semibold))
        let mono = scaled(UIFont.monospacedSystemFont(ofSize: DesignTokens.TypeScale.secondary.size, weight: .regular))
        let text = UIColor(Color.hmText)
        let muted = UIColor(Color.hmMuted)
        func paragraph(_ spacing: CGFloat) -> NSParagraphStyle {
            let style = NSMutableParagraphStyle()
            style.paragraphSpacing = spacing
            return style
        }
        func inline(_ source: String, color: UIColor = text) -> NSAttributedString {
            let parsed = AnswerText.inline(source)
            let out = NSMutableAttributedString()
            for run in parsed.runs {
                let piece = String(parsed[run.range].characters)
                var font = body
                let intent = run.inlinePresentationIntent ?? []
                if intent.contains(.stronglyEmphasized) { font = bold }
                if intent.contains(.code) { font = mono }
                if intent.contains(.emphasized), let italic = font.fontDescriptor.withSymbolicTraits(.traitItalic) {
                    font = UIFont(descriptor: italic, size: font.pointSize)
                }
                var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
                if let link = run.link { attributes[.link] = link }
                out.append(NSAttributedString(string: piece, attributes: attributes))
            }
            return out
        }
        let gap = DesignTokens.Chat.answerBlockGap
        func add(_ piece: NSAttributedString) {
            if result.length > 0 { result.append(NSAttributedString(string: "\n")) }
            let block = NSMutableAttributedString(attributedString: piece)
            block.addAttribute(.paragraphStyle, value: paragraph(gap), range: NSRange(location: 0, length: block.length))
            result.append(block)
        }
        guard message.fromAgent else {
            add(inline(MessageCopy.text(message.text, fromAgent: false)))
            return result
        }
        for block in AnswerMarkdown.blocks(message.text) {
            switch block {
            case let .paragraph(source):
                add(inline(source))
            case let .heading(_, source):
                let heading = NSMutableAttributedString(attributedString: inline(source))
                heading.addAttribute(.font, value: bold, range: NSRange(location: 0, length: heading.length))
                add(heading)
            case let .bullets(items):
                for item in items {
                    let line = NSMutableAttributedString(string: "•\t", attributes: [.font: body, .foregroundColor: text])
                    line.append(inline(item))
                    add(line)
                }
            case let .numbered(start, items):
                for (offset, item) in items.enumerated() {
                    let line = NSMutableAttributedString(string: "\(start + offset).\t", attributes: [.font: body, .foregroundColor: text])
                    line.append(inline(item))
                    add(line)
                }
            case let .quote(source):
                add(inline(source, color: muted))
            case let .code(_, source):
                add(NSAttributedString(string: source, attributes: [.font: mono, .foregroundColor: text]))
            case let .table(header, rows):
                for row in [header] + rows {
                    let line = NSMutableAttributedString()
                    for (index, cell) in row.enumerated() {
                        if index > 0 { line.append(NSAttributedString(string: "\t", attributes: [.font: body])) }
                        line.append(inline(cell))
                    }
                    add(line)
                }
            case .rule:
                add(NSAttributedString(string: "———", attributes: [.font: body, .foregroundColor: muted]))
            }
        }
        return result
    }

    private static func scaled(_ font: UIFont) -> UIFont {
        UIFontMetrics(forTextStyle: .body).scaledFont(for: font)
    }
}
#endif
