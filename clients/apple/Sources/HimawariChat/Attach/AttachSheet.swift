#if os(iOS)
import HimawariCore
import HimawariDesign
import Photos
import PhotosUI
import SwiftUI
import UIKit

struct AttachSheet: View {
    let limits: AttachmentLimits
    let chosen: [ChatAttachment]
    var readsPhotoLibrary = true
    let add: ([ChatAttachment]) -> Void
    let remove: (String) -> Void
    let failed: (AttachFailure) -> Void
    let close: () -> Void
    @State private var cameraOpen = false
    @State private var filesOpen = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var locating = false
    @State private var place = CurrentPlace()
    @State private var recent = RecentPhotos()
    @State private var loading: Set<String> = []
    @Environment(\.openURL) private var openURL

    private var room: Int { max(0, limits.perMessage - chosen.count) }
    private var full: Bool { room == 0 }
    private var allowsImages: Bool { limits.imageCharacters > 0 }
    private var chosenIds: Set<String> { Set(chosen.map(\.id)) }

    var body: some View {
        NavigationStack {
            List {
                if allowsImages {
                    Section {
                        recentRow
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    } footer: {
                        if full { Text(L.format("attach.problem.tooMany", limits.perMessage)) }
                    }
                }
                Section {
                    if allowsImages {
                        Button { cameraOpen = true } label: { row(.camera, L.text("attach.camera")) }
                            .disabled(full)
                    }
                    Button { filesOpen = true } label: { row(.fileText, L.text("attach.files")) }
                        .disabled(full)
                    Button(action: locate) {
                        HStack {
                            row(.mapPin, L.text("attach.location"))
                            Spacer()
                            if locating { ProgressView() }
                        }
                    }
                    .disabled(full || locating)
                } footer: {
                    if full, !allowsImages { Text(L.format("attach.problem.tooMany", limits.perMessage)) }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .himawariScreenBackground()
            .navigationTitle(L.text("attach.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L.text("common.close"), systemImage: "xmark", action: close)
                }
                if allowsImages {
                    ToolbarItem(placement: .primaryAction) {
                        PhotosPicker(selection: $photos, maxSelectionCount: max(1, room), matching: .images) {
                            Text(L.text("attach.photos"))
                        }
                        .disabled(full)
                    }
                }
            }
        }
        .task {
            if allowsImages, readsPhotoLibrary { await recent.start() }
        }
        .onDisappear { recent.stop() }
        .fullScreenCover(isPresented: $cameraOpen) {
            CameraPicker { image in
                cameraOpen = false
                if let image, let attachment = AttachReader.image(image, name: L.text("attach.camera")) {
                    add([attachment])
                    close()
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $filesOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            var picked: [ChatAttachment] = []
            for url in urls.prefix(max(1, room)) {
                do {
                    let attachment = try AttachReader.file(at: url)
                    if attachment.isImage, !allowsImages {
                        failed(.imagesUnsupported)
                    } else {
                        picked.append(attachment)
                    }
                } catch let failure as AttachFailure {
                    failed(failure)
                } catch {
                    failed(.unreadable)
                }
            }
            if !picked.isEmpty {
                add(picked)
                close()
            }
        }
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task {
                var picked: [ChatAttachment] = []
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let attachment = AttachReader.image(data: data, name: L.text("attach.photos")) {
                        picked.append(attachment)
                    } else {
                        failed(.unreadable)
                    }
                }
                if !picked.isEmpty {
                    add(picked)
                    close()
                }
            }
        }
    }

    private func row(_ icon: IconName, _ title: String) -> some View {
        Label {
            Text(title).hmType(DesignTokens.TypeScale.body)
        } icon: {
            Icon(icon, size: DesignTokens.Chat.attachRowIcon)
        }
        .foregroundStyle(Color.hmText)
    }

    @ViewBuilder
    private var recentRow: some View {
        let height = DesignTokens.Chat.attachRecentHeight
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Chat.attachRecentRadius, style: .continuous)
        switch recent.access {
        case .asking:
            ScrollView(.horizontal) {
                HStack(spacing: DesignTokens.Chat.attachTileGap) {
                    ForEach(0..<RecentPhotos.placeholders, id: \.self) { _ in
                        shape.fill(Color.hmFill).frame(width: height, height: height)
                    }
                }
            }
            .scrollIndicators(.hidden)
            .scrollDisabled(true)
            .accessibilityHidden(true)
        case .denied:
            VStack(alignment: .leading, spacing: DesignTokens.Size.rowGap) {
                Text(L.text("attach.recent.denied"))
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                Button(L.text("attach.recent.settings")) {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
                .hmType(DesignTokens.TypeScale.caption)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, DesignTokens.Size.cardPaddingX)
        case .full, .limited:
            ScrollView(.horizontal) {
                LazyHStack(spacing: DesignTokens.Chat.attachTileGap) {
                    ForEach(recent.assets, id: \.localIdentifier) { asset in
                        let id = RecentPhotos.id(of: asset)
                        let selected = chosenIds.contains(id)
                        RecentPhotoTile(asset: asset, photos: recent, selected: selected, loading: loading.contains(id)) {
                            toggle(asset)
                        }
                        .disabled(full && !selected)
                        .opacity(full && !selected ? DesignTokens.Options.staleOpacity : 1)
                    }
                    if recent.access == .limited {
                        Button(action: recent.chooseMore) {
                            VStack(spacing: DesignTokens.Size.rowGap) {
                                Icon(.plus, size: DesignTokens.Chat.attachRowIcon)
                                Text(L.text("attach.recent.more"))
                                    .hmType(DesignTokens.TypeScale.caption)
                                    .multilineTextAlignment(.center)
                            }
                            .foregroundStyle(Color.hmText)
                            .frame(width: height, height: height)
                            .background(Color.hmFill, in: shape)
                            .contentShape(shape)
                        }
                        .buttonStyle(.pressable)
                    }
                }
                .frame(height: height)
                .padding(.horizontal, DesignTokens.Size.cardPaddingX)
            }
            .scrollIndicators(.hidden)
        }
    }

    private func toggle(_ asset: PHAsset) {
        let id = RecentPhotos.id(of: asset)
        if chosenIds.contains(id) {
            remove(id)
            return
        }
        guard !full, !loading.contains(id) else { return }
        loading.insert(id)
        Task {
            defer { loading.remove(id) }
            if let attachment = await recent.attachment(for: asset, name: L.text("attach.photos")) {
                add([attachment])
            } else {
                failed(.unreadable)
            }
        }
    }

    private func locate() {
        locating = true
        Task {
            defer { locating = false }
            do {
                add([try await place.attachment(name: L.text("attach.location"))])
                close()
            } catch {
                failed(.noLocation)
            }
        }
    }
}

private struct RecentPhotoTile: View {
    let asset: PHAsset
    let photos: RecentPhotos
    let selected: Bool
    let loading: Bool
    let toggle: () -> Void
    @State private var image: UIImage?
    @Environment(\.displayScale) private var scale

    var body: some View {
        let height = DesignTokens.Chat.attachRecentHeight
        let width = RecentPhotos.width(of: asset, height: height)
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Chat.attachRecentRadius, style: .continuous)
        Button(action: toggle) {
            ZStack(alignment: .topTrailing) {
                Group {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Color.hmFill
                    }
                }
                .frame(width: width, height: height)
                .clipShape(shape)
                if loading {
                    ProgressView()
                        .frame(width: width, height: height)
                } else if selected {
                    Icon(.check, size: DesignTokens.Chat.attachRowIcon)
                        .foregroundStyle(Color.hmOnText)
                        .frame(width: DesignTokens.Chat.attachRecentCheck, height: DesignTokens.Chat.attachRecentCheck)
                        .background(Color.hmSun, in: Circle())
                        .padding(DesignTokens.Chat.listMarkerGap)
                }
            }
            .contentShape(shape)
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(Text(L.text("attach.recent.photo")))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .task(id: asset.localIdentifier) {
            image = await photos.thumbnail(for: asset, height: height, scale: scale)
        }
    }
}

struct AttachmentChips: View {
    let attachments: [ChatAttachment]
    var retry: (() -> Void)?
    let remove: (String) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: DesignTokens.Chat.attachTileGap) {
                ForEach(attachments) { attachment in
                    HStack(spacing: DesignTokens.Chat.listMarkerGap) {
                        preview(attachment)
                        Text(attachment.name)
                            .hmType(DesignTokens.TypeScale.caption)
                            .lineLimit(1)
                        Button { remove(attachment.id) } label: {
                            Icon(.x, size: DesignTokens.Chat.attachRowIcon)
                                .frame(minWidth: DesignTokens.Size.minTapTarget, minHeight: DesignTokens.Size.minTapTarget)
                        }
                        .buttonStyle(.pressable)
                        .accessibilityLabel(Text(L.format("attach.remove", attachment.name)))
                    }
                    .foregroundStyle(Color.hmText)
                    .padding(.horizontal, DesignTokens.Chat.listMarkerGap)
                    .frame(minHeight: DesignTokens.Chat.attachRowTile + DesignTokens.Chat.listMarkerGap)
                    .glassEffect(.regular, in: Capsule())
                }
                if let retry {
                    Button(action: retry) {
                        HStack(spacing: DesignTokens.Chat.listMarkerGap) {
                            Icon(.refresh, size: DesignTokens.Chat.attachRowIcon)
                            Text(L.text("attach.retry")).hmType(DesignTokens.TypeScale.caption)
                        }
                        .foregroundStyle(Color.hmText)
                        .padding(.horizontal, DesignTokens.Chat.listMarkerGap)
                        .frame(minWidth: DesignTokens.Size.minTapTarget, minHeight: DesignTokens.Chat.attachRowTile + DesignTokens.Chat.listMarkerGap)
                        .glassEffect(.regular, in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.pressable)
                }
            }
            .padding(.horizontal, DesignTokens.Size.composerInsetX)
        }
        .scrollIndicators(.hidden)
    }

    @ViewBuilder
    private func preview(_ attachment: ChatAttachment) -> some View {
        if case let .image(data, _) = attachment.content, let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: DesignTokens.Chat.attachRowTile, height: DesignTokens.Chat.attachRowTile)
                .clipShape(Circle())
        } else {
            Icon(attachment.name == L.text("attach.location") ? .mapPin : .fileText, size: DesignTokens.Chat.attachRowIcon)
        }
    }
}
#endif
