import HimawariCore
import HimawariDesign
import SwiftUI
import UniformTypeIdentifiers

struct ArchiveDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.zip] }

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

struct DataTransferPage: View {
    enum Part {
        case export
        case importing
    }

    let export: DataExportStore
    let importer: MemoryImportStore
    var part: Part? = nil
    let openPaste: () -> Void
    let openPreview: () -> Void
    let back: () -> Void
    @State private var saving = false
    @State private var saved = false
    @State private var picking: MemoryImportSource = .codex
    @State private var pickerShown = false

    var body: some View {
        SettingsPage {
            SheetHeader(title: title, leading: .back, action: back)
            if part != .importing {
                SettingsGroup(label: part == nil ? M.exportGroup : nil) {
                    exportRows
                }
                note(M.exportNote)
            }
            if part != .export {
                SettingsGroup(label: part == nil ? M.importGroup : nil) {
                    ForEach(MemoryImportSource.allCases, id: \.self) { source in
                        Button { choose(source) } label: {
                            SettingsRow(
                                icon: nil,
                                title: M.importSource(source),
                                detail: M.importSourceHelp(source),
                                chevron: true)
                        }
                        .buttonStyle(.pressable)
                        .disabled(export.running)
                    }
                }
            }
        }
        .fileExporter(
            isPresented: $saving,
            document: readyArchive.map { ArchiveDocument(data: $0.data) },
            contentType: .zip,
            defaultFilename: readyArchive?.fileName
        ) { result in
            if case .success = result { saved = true }
        }
        .fileImporter(
            isPresented: $pickerShown,
            allowedContentTypes: picking == .himawari ? [.json] : [.plainText, UTType(filenameExtension: "md") ?? .plainText],
            allowsMultipleSelection: picking == .codex
        ) { result in
            let source = picking
            guard case .success(let urls) = result, !urls.isEmpty else { return }
            guard let files = Self.read(urls) else {
                importer.unreadable(source)
                openPreview()
                return
            }
            openPreview()
            Task { await importer.preview(source, files: files) }
        }
    }

    private var title: String {
        switch part {
        case .export: M.exportAction
        case .importing: M.importGroup
        case nil: M.transferTitle
        }
    }

    private func choose(_ source: MemoryImportSource) {
        importer.reset()
        if source == .assistant {
            openPaste()
        } else {
            picking = source
            pickerShown = true
        }
    }

    static func read(_ urls: [URL]) -> [MemoryImportFile]? {
        var files: [MemoryImportFile] = []
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return nil }
            files.append(MemoryImportFile(name: url.lastPathComponent, text: text))
        }
        return files
    }

    private var readyArchive: ExportedArchive? {
        if case .ready(let archive) = export.phase { return archive }
        return nil
    }

    @ViewBuilder private var exportRows: some View {
        switch export.phase {
        case .idle:
            Button { Task { await export.start(reason: M.confirmExport) } } label: {
                SettingsRow(icon: nil, title: M.exportAction, chevron: true)
            }
            .buttonStyle(.pressable)
        case .running(let read, let total):
            HStack(spacing: SL.rowGap) {
                ProgressView()
                SettingsRow(
                    icon: nil,
                    title: M.exportWorking,
                    detail: read.flatMap { read in total.map { M.exportProgress(read: read, total: $0) } })
            }
            .accessibilityElement(children: .combine)
        case .ready(let archive):
            SettingsRow(
                icon: nil,
                title: M.exportDone(memories: archive.memories, rules: archive.rules, withheld: archive.withheld)
            )
            Button { saving = true } label: {
                SettingsRow(icon: nil, title: M.exportSave, value: saved ? M.exportSaved : nil, chevron: !saved)
            }
            .buttonStyle(.pressable)
        case .failed:
            Button { Task { await export.start(reason: M.confirmExport) } } label: {
                SettingsRow(icon: nil, title: M.exportAction, warning: M.exportFailed, chevron: true)
            }
            .buttonStyle(.pressable)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(Color.hmMuted)
            .padding(.horizontal, SL.groupLabelPadding)
            .outsideRowCard()
    }
}
