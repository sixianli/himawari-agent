import HimawariCore
import HimawariDesign
import SwiftUI
#if os(iOS)
import QuickLook
import UIKit
#endif

struct SharedFile: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

struct FilesPage: View {
    @Bindable var store: OwnerFilesStore
    @State private var previewing: URL?
    @State private var sharing: SharedFile?
    @State private var opening: String?
    @State private var openFailed = false

    var body: some View {
        List {
            ForEach(store.files) { file in
                row(file)
            }
            if store.hasMore {
                Button {
                    Task { await store.loadMore() }
                } label: {
                    if store.loadingMore { ProgressView().frame(maxWidth: .infinity) } else { Text(M.filesLoadMore) }
                }
                .task { await store.loadMore() }
            }
        }
        .listStyle(.plain)
        .overlay {
            if store.files.isEmpty {
                switch store.phase {
                case .loading: ProgressView()
                case .failed: ContentUnavailableView(M.filesLoadFailed, systemImage: "exclamationmark.triangle")
                default:
                    if store.search.trimmingCharacters(in: .whitespaces).isEmpty {
                        ContentUnavailableView(M.filesEmpty, systemImage: "folder", description: Text(M.filesEmptyDetail))
                    } else {
                        ContentUnavailableView.search(text: store.search)
                    }
                }
            }
        }
        .navigationTitle(M.filesTitle)
        .searchable(text: $store.search, prompt: M.filesSearch)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker(M.filesFilter, selection: $store.filter) {
                        ForEach(OwnerFileFilter.choices) { filter in
                            Text(M.fileFilter(filter)).tag(filter)
                        }
                    }
                } label: {
                    Label(M.filesFilter, systemImage: store.filter == .all ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
            }
        }
        .refreshable { await store.load() }
        .task(id: QueryKey(filter: store.filter, search: store.search)) {
            if !store.search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await store.load()
        }
        #if os(iOS)
        .quickLookPreview($previewing)
        .sheet(item: $sharing) { file in
            ActivitySheet(items: [file.url])
                .presentationDetents([.medium, .large])
        }
        #endif
        .alert(M.filesOpenFailed, isPresented: $openFailed) {}
    }

    private struct QueryKey: Equatable {
        let filter: OwnerFileFilter
        let search: String
    }

    private func row(_ file: OwnerFile) -> some View {
        Button {
            open(file) { previewing = $0 }
        } label: {
            HStack(spacing: 12) {
                Icon(M.fileIcon(file.kind), size: DesignTokens.IconSize.listRow)
                    .foregroundStyle(Color.hmSun)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.name)
                        .font(.body)
                        .foregroundStyle(file.canOpen ? Color.primary : Color.secondary)
                        .lineLimit(2)
                    Text(file.deleted ? M.filesDeleted : M.filesFrom(file.createdAt, version: file.version))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if opening == file.fileId { ProgressView() }
            }
            .contentShape(Rectangle())
        }
        .disabled(!file.canOpen)
        .swipeActions(edge: .trailing) {
            if file.canOpen {
                Button {
                    open(file) { sharing = SharedFile(url: $0) }
                } label: {
                    Label(M.filesShare, systemImage: "square.and.arrow.up")
                }
                .tint(.accentColor)
            }
        }
        .contextMenu {
            if file.canOpen {
                Button {
                    open(file) { sharing = SharedFile(url: $0) }
                } label: {
                    Label(M.filesShare, systemImage: "square.and.arrow.up")
                }
            }
        }
    }

    private func open(_ file: OwnerFile, then show: @escaping (URL) -> Void) {
        guard file.canOpen, opening == nil else { return }
        opening = file.fileId
        Task {
            defer { opening = nil }
            do {
                show(try await store.localCopy(file))
            } catch {
                openFailed = true
            }
        }
    }
}

#if os(iOS)
struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#endif
