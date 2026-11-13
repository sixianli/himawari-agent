#if os(macOS)
import HimawariChat
import HimawariCore
import HimawariDesign
import SwiftUI
import UniformTypeIdentifiers

struct InputBarView: View {
    @Bindable var model: InputBarModel
    let shortcutLabel: String?
    let submit: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        GlassPanel(radius: DesignTokens.Mac.inputBarRadius) {
            VStack(alignment: .leading, spacing: 0) {
                if !model.pieces.isEmpty {
                    chips
                }
                inputRow
                if let problem = model.problem {
                    Text(Self.text(for: problem))
                        .hmType(DesignTokens.TypeScale.macSmall)
                        .foregroundStyle(Color.hmDanger)
                        .padding(.horizontal, DesignTokens.Mac.inputInnerPaddingX)
                        .padding(.bottom, DesignTokens.Mac.inputBarPaddingY)
                } else if model.queuedOffline {
                    Text(L.text("input.offline"))
                        .hmType(DesignTokens.TypeScale.macSmall)
                        .foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, DesignTokens.Mac.inputInnerPaddingX)
                        .padding(.bottom, DesignTokens.Mac.inputBarPaddingY)
                }
                if model.threadId != nil {
                    answer
                }
            }
            .padding(.horizontal, DesignTokens.Mac.inputBarPaddingX)
            .padding(.vertical, DesignTokens.Mac.inputBarPaddingY)
        }
        .frame(width: DesignTokens.Mac.inputBarWidth)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            Self.loadFiles(providers) { model.add(files: $0) }
            return true
        }
        .onAppear { focused = true }
    }

    private var chips: some View {
        FlowRow(spacing: DesignTokens.Mac.inputChipGap) {
            ForEach(model.pieces) { piece in
                ContextChipView(piece: piece) { model.remove(piece.id) }
            }
        }
        .padding(.horizontal, DesignTokens.Mac.inputInnerPaddingX)
        .padding(.top, DesignTokens.Mac.inputChipsTop)
        .padding(.bottom, DesignTokens.Mac.inputChipsBottom)
    }

    private var inputRow: some View {
        HStack(spacing: DesignTokens.Mac.inputGap) {
            SunflowerBadge(size: DesignTokens.Mac.inputMark)
            TextField(L.text("input.placeholder"), text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .hmType(DesignTokens.TypeScale.macInput)
                .foregroundStyle(Color.hmText)
                .lineLimit(1...4)
                .focused($focused)
                .onSubmit(submit)
                .disabled(model.sending)
            if model.sending {
                ProgressView().controlSize(.small)
            } else if let shortcutLabel, model.draft.isEmpty {
                Text(shortcutLabel)
                    .hmType(DesignTokens.TypeScale.macButtonSmall)
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .padding(.horizontal, DesignTokens.Mac.inputInnerPaddingX)
        .frame(minHeight: DesignTokens.Mac.inputRowHeight)
    }

    @ViewBuilder
    private var answer: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Mac.panelGap) {
            Divider().overlay(Color.hmSeparator)
            if let line = model.runningProcess {
                ProcessRowView(line: line, failed: false)
            }
            if let text = model.answer {
                ScrollView {
                    Text(text)
                        .hmType(DesignTokens.TypeScale.macAnswer)
                        .foregroundStyle(Color.hmText)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: DesignTokens.Mac.inputAnswerMaxHeight)
                Text(L.text("input.openOnPhone"))
                    .hmType(DesignTokens.TypeScale.macSmall)
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .padding(.horizontal, DesignTokens.Mac.inputInnerPaddingX)
        .padding(.bottom, DesignTokens.Mac.inputChipsTop)
    }

    static func text(for problem: InputBarModel.Problem) -> String {
        switch problem {
        case .tooMany: L.text("input.tooMany")
        case .tooLong: L.text("input.tooLong")
        case .attachmentsUnsupported: L.text("input.attachmentsUnsupported")
        case .uploadFailed: L.text("input.uploadFailed")
        case .sendFailed: L.text("input.sendFailed")
        }
    }

    static func loadFiles(_ providers: [NSItemProvider], into deliver: @escaping @MainActor ([URL]) -> Void) {
        let files = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !files.isEmpty else { return }
        Task { @MainActor in
            var urls: [URL] = []
            for provider in files {
                if let url = await fileURL(provider) { urls.append(url) }
            }
            if !urls.isEmpty { deliver(urls) }
        }
    }

    private static func fileURL(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { url, _ in continuation.resume(returning: url) }
        }
    }
}

struct FlowRow: Layout {
    let spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(rows.count - 1, 0))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width, !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
#endif
