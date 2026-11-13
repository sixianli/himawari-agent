#if os(iOS)
import Foundation
import HimawariCore
import Photos

@MainActor
public final class PhotosCollector: NSObject, SenseCollector, @preconcurrency PHPhotoLibraryChangeObserver {
    public let item = SenseItem.photos
    static let sinceName = "photos-since"
    private var sink: SenseSink?
    private var registered = false

    override public init() {
        super.init()
    }

    public func authorization() async -> SenseAuthorization {
        Self.map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    public func requestAuthorization() async -> SenseAuthorization {
        Self.map(await PHPhotoLibrary.requestAuthorization(for: .readWrite))
    }

    public func start(_ sink: SenseSink) {
        self.sink = sink
        if since(sink.localStore) == nil { save(Date(), to: sink.localStore) }
        if !registered {
            PHPhotoLibrary.shared().register(self)
            registered = true
        }
        collect()
    }

    public func stop() {
        if registered { PHPhotoLibrary.shared().unregisterChangeObserver(self) }
        registered = false
        if let sink { try? sink.localStore.write(Self.sinceName, nil) }
        sink = nil
    }

    public func photoLibraryDidChange(_ changeInstance: PHChange) {
        collect()
    }

    private func collect() {
        guard let sink, let start = since(sink.localStore) else { return }
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "creationDate > %@ AND mediaType == %d", start as NSDate, PHAssetMediaType.image.rawValue)
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let assets = PHAsset.fetchAssets(with: options)
        var newest = start
        assets.enumerateObjects { asset, _, _ in
            guard let created = asset.creationDate else { return }
            let screenshot = asset.mediaSubtypes.contains(.photoScreenshot)
            let observation = SenseObservations.photo(
                assetId: asset.localIdentifier,
                screenshot: screenshot,
                createdAt: created,
                latitude: asset.location?.coordinate.latitude,
                longitude: asset.location?.coordinate.longitude
            )
            sink.record(observation, id: SenseRecordBuilder.stableId(["photo", asset.localIdentifier]))
            newest = max(newest, created)
        }
        save(newest, to: sink.localStore)
    }

    private func since(_ store: LocalStore) -> Date? {
        store.read(Self.sinceName).flatMap { String(data: $0, encoding: .utf8) }.flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
    }

    private func save(_ date: Date, to store: LocalStore) {
        try? store.write(Self.sinceName, Data(String(date.timeIntervalSince1970).utf8))
    }

    static func map(_ status: PHAuthorizationStatus) -> SenseAuthorization {
        switch status {
        case .notDetermined: .notAsked
        case .authorized: .allowed
        case .limited: .limited
        case .restricted: .restricted
        case .denied: .denied
        @unknown default: .denied
        }
    }
}
#endif
