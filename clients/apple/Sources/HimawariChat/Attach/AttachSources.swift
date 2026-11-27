#if os(iOS)
import CoreLocation
import Foundation
import HimawariCore
import PDFKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

enum AttachFailure: Error, Equatable {
    case unreadable
    case noLocation
    case tooLarge
    case imagesUnsupported
}

enum AttachReader {
    static let jpegQuality: CGFloat = 0.85

    static func image(_ image: UIImage, name: String) -> ChatAttachment? {
        guard let data = image.jpegData(compressionQuality: jpegQuality) else { return nil }
        return ChatAttachment(name: name, content: .image(data: data, mimeType: "image/jpeg"))
    }

    static func image(data: Data, name: String) -> ChatAttachment? {
        guard let jpeg = ImageDownsampling.jpeg(data, quality: jpegQuality) else { return nil }
        return ChatAttachment(name: name, content: .image(data: jpeg, mimeType: "image/jpeg"), originalBytes: data.count)
    }

    static func file(at url: URL) throws -> ChatAttachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
        guard ChatAttachmentPlanner.fileFits(bytes: size) else { throw size == nil ? AttachFailure.unreadable : AttachFailure.tooLarge }
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        if type.conforms(to: .image) {
            guard let data = try? Data(contentsOf: url), let attachment = image(data: data, name: name) else { throw AttachFailure.unreadable }
            return attachment
        }
        if type.conforms(to: .pdf) {
            guard let document = PDFDocument(url: url), let text = document.string, !text.isEmpty else { throw AttachFailure.unreadable }
            return ChatAttachment(name: name, content: .text(text, kind: .pdf), originalBytes: size)
        }
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8), !text.isEmpty else {
            throw AttachFailure.unreadable
        }
        return ChatAttachment(name: name, content: .text(text, kind: .text), originalBytes: size)
    }
}

@MainActor
final class CurrentPlace: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var authorizationWaiters: [CheckedContinuation<Void, Never>] = []
    private var locationWaiter: CheckedContinuation<CLLocation?, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    func attachment(name: String) async throws -> ChatAttachment {
        if manager.authorizationStatus == .notDetermined {
            await withCheckedContinuation { continuation in
                authorizationWaiters.append(continuation)
                manager.requestWhenInUseAuthorization()
            }
        }
        guard [.authorizedWhenInUse, .authorizedAlways].contains(manager.authorizationStatus) else { throw AttachFailure.noLocation }
        let location: CLLocation? = await withCheckedContinuation { continuation in
            locationWaiter?.resume(returning: nil)
            locationWaiter = continuation
            manager.requestLocation()
        }
        guard let location else { throw AttachFailure.noLocation }
        let address = try? await CLGeocoder().reverseGeocodeLocation(location).first.map(Self.address)
        return ChatAttachment(name: name, content: .text(Self.describe(location, address: address ?? nil), kind: .text))
    }

    static func address(_ placemark: CLPlacemark) -> String? {
        let parts = [placemark.name, placemark.thoroughfare, placemark.locality, placemark.administrativeArea, placemark.country]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        var seen = Set<String>()
        let unique = parts.filter { seen.insert($0).inserted }
        return unique.isEmpty ? nil : unique.joined(separator: ", ")
    }

    static func describe(_ location: CLLocation, address: String?) -> String {
        let point = String(format: "lat %.5f, lon %.5f (±%.0f m)", location.coordinate.latitude, location.coordinate.longitude, location.horizontalAccuracy)
        return [address, point, ISO8601DateFormatter().string(from: location.timestamp)].compactMap { $0 }.joined(separator: "\n")
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined else { return }
        let waiting = authorizationWaiters
        authorizationWaiters.removeAll()
        waiting.forEach { $0.resume() }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        locationWaiter?.resume(returning: locations.last(where: { $0.horizontalAccuracy >= 0 }))
        locationWaiter = nil
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        locationWaiter?.resume(returning: nil)
        locationWaiter = nil
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    let picked: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(picked: picked) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let picked: (UIImage?) -> Void

        init(picked: @escaping (UIImage?) -> Void) {
            self.picked = picked
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            picked(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picked(nil)
        }
    }
}
#endif
