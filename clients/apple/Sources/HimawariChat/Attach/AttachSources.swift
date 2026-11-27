#if os(iOS)
import Foundation
import HimawariCore
import PDFKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

enum AttachFailure: Error, Equatable {
    case unreadable
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
