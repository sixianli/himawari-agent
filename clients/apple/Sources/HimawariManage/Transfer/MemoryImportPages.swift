import HimawariCore
import HimawariDesign
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct MemoryImportPastePage: View {
    let store: MemoryImportStore
    let openPreview: () -> Void
    let back: () -> Void
    @State private var pasted = ""
    @State private var copied = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.importSource(.assistant), leading: .back, action: back)
            SettingsGroup(label: M.aiStep1) {
                Text(M.aiPrompt)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                    .textSelection(.enabled)
                    .padding(.vertical, SL.rowPaddingVertical)
                    .frame(maxWidth: .infinity, alignment: .leading)
                RowSeparator()
                Button(action: copy) {
                    SettingsRow(icon: nil, title: M.copyPrompt, value: copied ? M.copied : nil, last: true)
                }
                .buttonStyle(.pressable)
            }
            SettingsGroup(label: M.aiStep2) {
                TextEditor(text: $pasted)
                    .hmType(DesignTokens.TypeScale.body)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: DesignTokens.Size.emptyMinHeight)
                    .accessibilityLabel(M.aiStep2)
            }
            Button {
                let text = pasted
                openPreview()
                Task { await store.preview(.assistant, files: [MemoryImportFile(name: M.importSource(.assistant), text: text)]) }
            } label: {
                Text(M.splitIntoItems).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func copy() {
        #if canImport(UIKit)
        UIPasteboard.general.string = M.aiPrompt
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(M.aiPrompt, forType: .string)
        #endif
        copied = true
    }
}

struct MemoryImportPreviewPage: View {
    let store: MemoryImportStore
    let finish: () -> Void
    let back: () -> Void
    @State private var failed = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.importGroup, leading: .back, action: back)
            content
        }
        .toolbar {
            if store.phase == .preview {
                ToolbarItem(placement: .confirmationAction) {
                    Button(M.importCommit(store.chosen.count)) {
                        Task { failed = !(await store.commit(reason: M.confirmImport(store.chosen.count))) }
                    }
                    .disabled(store.chosen.isEmpty)
                }
            }
            if isDone {
                ToolbarItem(placement: .confirmationAction) {
                    Button(M.done, action: finish)
                }
            }
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private var isDone: Bool {
        if case .done = store.phase { return true }
        return false
    }

    @ViewBuilder private var content: some View {
        switch store.phase {
        case .idle, .reading, .importing:
            VStack(spacing: SL.groupGap) {
                ProgressView()
                if store.phase == .reading {
                    Text(M.importReading)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
        case .preview:
            SettingsGroup(label: M.importSummary(found: store.found, shown: store.items.count, on: store.chosen.count)) {
                ForEach(store.items) { item in
                    ImportItemRow(item: item, last: item == store.items.last) { store.toggle(item) }
                }
            }
        case .done(let count):
            EmptyStateView(Text(M.importDone(count))).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        case .problem(let problem):
            EmptyStateView(Text(Self.message(problem))).frame(minHeight: DesignTokens.Size.emptyMinHeight)
        }
    }

    static func message(_ problem: MemoryImportStore.Problem) -> String {
        switch problem {
        case .tooManyFiles(let maximum): M.importTooMany(maximum)
        case .tooLong(let name, let maximum): M.importTooLong(name, maximum)
        case .nothingFound: M.importEmpty
        case .unreadable: M.importUnreadable
        case .failed: M.actionFailed
        }
    }
}

struct ImportItemRow: View {
    let item: MemoryImportItem
    let last: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: SL.rowGap) {
                    VStack(alignment: .leading, spacing: SL.rowTextGap) {
                        Text(item.text).hmType(SL.rowValue).foregroundStyle(item.selectable ? Color.hmText : Color.hmMuted)
                        Text(item.from).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                        if let flag = item.flag.flatMap(M.importFlag) {
                            Text(flag).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Icon(.check, size: DesignTokens.IconSize.listRow)
                        .foregroundStyle(Color.hmSun)
                        .opacity(item.checked && item.selectable ? 1 : 0)
                }
                .padding(.vertical, SL.rowPaddingVertical)
                .frame(minHeight: SL.rowMinHeight)
                if !last { RowSeparator() }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(!item.selectable)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(item.checked && item.selectable ? .isSelected : [])
    }
}

struct ServerStatusPage: View {
    let store: ServerStatusStore
    let back: () -> Void

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.serverStatusTitle, leading: .back, action: back)
            switch store.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
            case .failed:
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            case .loaded(let status):
                SettingsGroup(label: nil) {
                    ForEach(Array(Self.rows(status).enumerated()), id: \.offset) { index, row in
                        SettingsRow(
                            icon: nil,
                            title: row.title,
                            detail: row.definition,
                            value: row.value,
                            tone: row.tone,
                            last: index == Self.rows(status).count - 1
                        )
                    }
                }
                if let checked = Timestamp.parse(status.generatedAt) {
                    Text(M.statusCheckedAt(checked))
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                }
            }
        }
        .refreshable { await store.load() }
        .task { await store.load() }
    }

    struct Row {
        let title: String
        let definition: String
        let value: String
        let tone: SettingsRow.Tone
    }

    static func rows(_ status: ServerStatus) -> [Row] {
        var rows = [
            Row(
                title: M.statusOverall,
                definition: M.statusOverallDefinition,
                value: M.statusOverallValue(status.status),
                tone: status.status == "healthy" ? .good : .attention
            ),
        ]
        if let worker = status.worker {
            let healthy = worker.status == "healthy"
            rows.append(Row(title: M.statusWorker, definition: M.statusWorkerDefinition, value: M.statusWorkerValue(healthy), tone: healthy ? .good : .attention))
        }
        if let release = status.release {
            rows.append(Row(title: M.statusVersion, definition: M.statusVersionDefinition, value: String(release.commit.prefix(7)), tone: .muted))
            if let installed = release.installedAt.flatMap(Timestamp.parse) {
                rows.append(Row(title: M.statusDeployed, definition: M.statusDeployedDefinition, value: installed.formatted(date: .abbreviated, time: .shortened), tone: .muted))
            }
        }
        if let disk = status.disk {
            rows.append(Row(title: M.statusDisk, definition: M.statusDiskDefinition, value: M.statusDiskValue(available: disk.availableBytes, total: disk.totalBytes), tone: .muted))
        }
        return rows
    }
}
