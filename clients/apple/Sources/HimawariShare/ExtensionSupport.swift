#if canImport(UIKit)
import HimawariCore
import HimawariDesign
import SwiftUI
import UIKit
import UniformTypeIdentifiers

public struct UIKitImageFitter: ImageFitting {
    public static let qualities: [CGFloat] = [0.85, 0.7, 0.55, 0.4]
    public static let shrinkStep: CGFloat = 0.75

    public init() {}

    public func fit(_ data: Data, maxBytes: Int) -> (data: Data, mimeType: String)? {
        guard maxBytes > 0, var image = UIImage(data: data) else { return nil }
        while min(image.size.width, image.size.height) >= 1 {
            for quality in Self.qualities {
                if let encoded = image.jpegData(compressionQuality: quality), encoded.count <= maxBytes {
                    return (encoded, "image/jpeg")
                }
            }
            let size = CGSize(width: (image.size.width * Self.shrinkStep).rounded(.down), height: (image.size.height * Self.shrinkStep).rounded(.down))
            guard size.width >= 1, size.height >= 1 else { return nil }
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            image = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        }
        return nil
    }
}

public enum SharedItemReader {
    public static func read(_ items: [NSExtensionItem]) async -> HandoverContent? {
        let providers = items.flatMap { $0.attachments ?? [] }
        let caption = items.compactMap { $0.attributedContentText?.string }.first { !$0.isEmpty }
        if let page = await firstPage(providers) { return page }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.url.identifier) }),
           let url = await load(URL.self, from: provider, type: .url), !url.isFileURL {
            return .link(url: url.absoluteString, title: caption)
        }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }),
           let image = await imageData(provider) {
            return .image(data: image.data, mimeType: image.mimeType, name: provider.suggestedName)
        }
        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }),
           let text = await load(String.self, from: provider, type: .plainText), !text.isEmpty {
            return .text(text)
        }
        if let caption { return .text(caption) }
        return nil
    }

    static func firstPage(_ providers: [NSItemProvider]) async -> HandoverContent? {
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier) {
            let fields: [String: String]? = await withCheckedContinuation { continuation in
                provider.loadItem(forTypeIdentifier: UTType.propertyList.identifier, options: nil) { item, _ in
                    let results = (item as? NSDictionary)?[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any]
                    continuation.resume(returning: results?.compactMapValues { $0 as? String })
                }
            }
            if let fields, let page = HandoverContent.page(from: fields) { return page }
        }
        return nil
    }

    static func load<T: Sendable>(_ type: T.Type, from provider: NSItemProvider, type identifier: UTType) async -> T? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: identifier.identifier, options: nil) { item, _ in
                if let value = item as? T { continuation.resume(returning: value); return }
                if T.self == String.self, let data = item as? Data, let text = String(data: data, encoding: .utf8) {
                    continuation.resume(returning: text as? T); return
                }
                if T.self == URL.self, let text = item as? String { continuation.resume(returning: URL(string: text) as? T); return }
                continuation.resume(returning: nil)
            }
        }
    }

    static func imageData(_ provider: NSItemProvider) async -> (data: Data, mimeType: String)? {
        let types = provider.registeredContentTypes.filter { $0.conforms(to: .image) }
        let pick = types.first { $0.preferredMIMEType.map(HandoverImageTypes.accepted.contains) ?? false } ?? types.first
        guard let pick else { return nil }
        let data: Data? = await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(for: pick) { data, _ in continuation.resume(returning: data) }
        }
        guard let data else { return nil }
        if let mime = pick.preferredMIMEType, HandoverImageTypes.accepted.contains(mime) { return (data, mime) }
        guard let jpeg = UIImage(data: data)?.jpegData(compressionQuality: UIKitImageFitter.qualities[0]) else { return nil }
        return (jpeg, "image/jpeg")
    }
}

public enum HandoverImageTypes {
    public static let accepted: Set<String> = ["image/png", "image/jpeg", "image/webp", "image/gif"]
}

@MainActor
public enum HandoverExtension {
    public static func desk(bundle: Bundle = .main) -> HandoverDesk? {
        let vault = SharedVault(bundle: bundle)
        guard let credentials = vault.activeCredentials(), let store = try? vault.handoverStore() else { return nil }
        let http = DeviceHTTPClient()
        http.use(credentials)
        return HandoverDesk(store: store, courier: HandoverCourier(api: DeviceAPI(http: http), images: UIKitImageFitter()))
    }

    public static func open(_ url: URL, from responder: UIResponder) {
        var current: UIResponder? = responder
        while let next = current {
            if let application = next as? UIApplication {
                application.open(url, options: [:], completionHandler: nil)
                return
            }
            current = next.next
        }
    }
}

open class HandoverHostController: UIViewController {
    private var model: HandoverSheetModel?

    open var entry: HandoverEntry { .share }

    override open func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        SerifFace.shared.prepare()
        Task { await load() }
    }

    private func load() async {
        nonisolated(unsafe) let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let content = await SharedItemReader.read(items)
        let model = HandoverSheetModel(entry: entry, content: content, sourceApp: nil, desk: HandoverExtension.desk())
        model.onClose = { [weak self] in self?.finish() }
        model.onOpen = { [weak self] url in
            guard let self else { return }
            HandoverExtension.open(url, from: self)
            finish()
        }
        self.model = model
        let host = UIHostingController(rootView: HandoverSheetScene(model: model))
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
#endif
