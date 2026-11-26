#if os(iOS)
import HimawariCore
import HimawariDesign
import PhotosUI
import SwiftUI
import UIKit

struct AttachSheet: View {
    let room: Int
    let add: ([ChatAttachment]) -> Void
    let failed: (AttachFailure) -> Void
    let close: () -> Void
    @State private var cameraOpen = false
    @State private var filesOpen = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var locating = false
    @State private var place = CurrentPlace()

    var body: some View {
        VStack(spacing: DesignTokens.Chat.attachSheetGap) {
            ZStack {
                Text(L.text("attach.title"))
                    .hmType(DesignTokens.TypeScale.sheetTitle)
                    .foregroundStyle(Color.hmText)
                HStack {
                    Button(action: close) {
                        Icon(.x, size: DesignTokens.IconSize.glassButton)
                            .foregroundStyle(Color.hmText)
                            .frame(width: DesignTokens.Size.glassButton, height: DesignTokens.Size.glassButton)
                            .background(Color.hmFill, in: Circle())
                    }
                    .buttonStyle(.pressable)
                    .accessibilityLabel(Text(L.text("common.close")))
                    Spacer()
                }
            }
            HStack(spacing: DesignTokens.Chat.attachTileGap) {
                Button { cameraOpen = true } label: { AttachTile(icon: .camera, title: L.text("attach.camera")) }
                    .buttonStyle(.pressable)
                PhotosPicker(selection: $photos, maxSelectionCount: max(1, room), matching: .images) {
                    AttachTile(icon: .photo, title: L.text("attach.photos"))
                }
                .buttonStyle(.pressable)
                Button { filesOpen = true } label: { AttachTile(icon: .fileText, title: L.text("attach.files")) }
                    .buttonStyle(.pressable)
            }
            Button(action: locate) {
                HStack(spacing: DesignTokens.Size.rowGap) {
                    Icon(.mapPin, size: DesignTokens.Chat.attachRowIcon)
                        .frame(width: DesignTokens.Chat.attachRowTile)
                    Text(L.text("attach.location"))
                        .hmType(DesignTokens.TypeScale.body)
                    Spacer()
                    if locating { ProgressView() }
                }
                .foregroundStyle(Color.hmText)
                .frame(minHeight: DesignTokens.Size.rowMinHeight)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .disabled(locating)
            .himawariCard(padding: EdgeInsets(top: 0, leading: DesignTokens.Size.cardPaddingX, bottom: 0, trailing: DesignTokens.Size.cardPaddingX))
        }
        .padding(.top, DesignTokens.Size.sheetPaddingTop)
        .padding(.horizontal, DesignTokens.Size.sheetPaddingHorizontal)
        .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
        .himawariScreenBackground()
        .fullScreenCover(isPresented: $cameraOpen) {
            CameraPicker { image in
                cameraOpen = false
                if let image, let attachment = AttachReader.image(image, name: L.text("attach.camera")) {
                    add([attachment])
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $filesOpen, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            var picked: [ChatAttachment] = []
            for url in urls.prefix(max(1, room)) {
                do {
                    picked.append(try AttachReader.file(at: url))
                } catch let failure as AttachFailure {
                    failed(failure)
                } catch {
                    failed(.unreadable)
                }
            }
            if !picked.isEmpty { add(picked) }
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
                if !picked.isEmpty { add(picked) }
            }
        }
    }

    private func locate() {
        locating = true
        Task {
            defer { locating = false }
            do {
                add([try await place.attachment(name: L.text("attach.location"))])
            } catch {
                failed(.noLocation)
            }
        }
    }
}

private struct AttachTile: View {
    let icon: IconName
    let title: String

    var body: some View {
        VStack(spacing: DesignTokens.Size.rowGap) {
            Icon(icon, size: DesignTokens.Chat.attachTileIcon)
            Text(title).hmType(DesignTokens.TypeScale.secondary)
        }
        .foregroundStyle(Color.hmText)
        .frame(maxWidth: .infinity, minHeight: DesignTokens.Chat.attachTileHeight)
        .himawariCard(padding: EdgeInsets())
        .contentShape(Rectangle())
    }
}

struct AttachmentChips: View {
    let attachments: [ChatAttachment]
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
