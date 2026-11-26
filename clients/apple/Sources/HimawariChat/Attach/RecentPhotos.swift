#if os(iOS)
import HimawariCore
import HimawariDesign
import Observation
import Photos
import SwiftUI
import UIKit

@MainActor
@Observable
final class RecentPhotos: NSObject {
    enum Access: Equatable {
        case asking
        case full
        case limited
        case denied
    }

    private(set) var access: Access = .asking
    private(set) var assets: [PHAsset] = []
    @ObservationIgnored private let manager = PHCachingImageManager()
    @ObservationIgnored private var observing = false

    static let shown = Int(DesignTokens.Chat.attachRecentCount)
    static let placeholders = 4

    func start() async {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        access = Self.access(status)
        guard access == .full || access == .limited else {
            assets = []
            return
        }
        if !observing {
            observing = true
            PHPhotoLibrary.shared().register(self)
        }
        reload()
    }

    func stop() {
        guard observing else { return }
        observing = false
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
    }

    func thumbnail(for asset: PHAsset, height: CGFloat, scale: CGFloat) async -> UIImage? {
        let size = CGSize(width: Self.width(of: asset, height: height) * scale, height: height * scale)
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        options.resizeMode = .fast
        return await withCheckedContinuation { continuation in
            manager.requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: options) { image, _ in
                continuation.resume(returning: image)
            }
        }
    }

    func attachment(for asset: PHAsset, name: String) async -> ChatAttachment? {
        let options = PHImageRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .highQualityFormat
        let data: Data? = await withCheckedContinuation { continuation in
            manager.requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
                continuation.resume(returning: data)
            }
        }
        guard let data, let picked = AttachReader.image(data: data, name: name) else { return nil }
        return ChatAttachment(id: Self.id(of: asset), name: picked.name, content: picked.content, originalBytes: picked.originalBytes)
    }

    func chooseMore() {
        guard let presenter = Self.topController() else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter) { _ in }
    }

    static func id(of asset: PHAsset) -> String {
        "recent-photo:" + asset.localIdentifier
    }

    static func width(of asset: PHAsset, height: CGFloat) -> CGFloat {
        guard asset.pixelHeight > 0 else { return height }
        let natural = height * CGFloat(asset.pixelWidth) / CGFloat(asset.pixelHeight)
        return min(natural, DesignTokens.Chat.attachRecentMaxWidth)
    }

    private func reload() {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = Self.shown
        let result = PHAsset.fetchAssets(with: .image, options: options)
        var found: [PHAsset] = []
        result.enumerateObjects { asset, _, _ in found.append(asset) }
        assets = found
    }

    private static func access(_ status: PHAuthorizationStatus) -> Access {
        switch status {
        case .authorized: .full
        case .limited: .limited
        case .notDetermined: .asking
        default: .denied
        }
    }

    private static func topController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        var top = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

extension RecentPhotos: PHPhotoLibraryChangeObserver {
    nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
        Task { @MainActor in
            access = Self.access(PHPhotoLibrary.authorizationStatus(for: .readWrite))
            reload()
        }
    }
}
#endif
