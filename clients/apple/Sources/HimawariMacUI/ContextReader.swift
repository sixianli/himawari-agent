#if os(macOS)
import AppKit
import ApplicationServices
import Foundation
import HimawariCore
import PDFKit

enum ContextReader {
    @MainActor
    static func snapshot(seesFrontmost: Bool, excluding ownBundleId: String?) -> ContextSnapshot {
        guard let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier != ownBundleId else {
            return ContextSnapshot()
        }
        let front = FrontApp(name: app.localizedName ?? app.bundleIdentifier ?? "", bundleId: app.bundleIdentifier)
        guard AXIsProcessTrusted() else { return ContextSnapshot(frontApp: seesFrontmost ? front : nil) }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        let window = child(element, kAXFocusedWindowAttribute)
        let documentText = window.flatMap { text($0, kAXDocumentAttribute) }
        let document = documentText.flatMap(URL.init(string:)).flatMap { $0.isFileURL ? $0 : nil }
        let focused = child(element, kAXFocusedUIElementAttribute)
        let selection = focused.flatMap { text($0, kAXSelectedTextAttribute) }
        return ContextSnapshot(
            frontApp: seesFrontmost ? front : nil,
            document: seesFrontmost ? document : nil,
            selection: selection
        )
    }

    private static func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private static func child(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = value(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private static func text(_ element: AXUIElement, _ name: String) -> String? {
        value(element, name) as? String
    }

    static func read(_ url: URL) -> FileReading {
        let plain = PlainTextFile.read(url)
        if case .text = plain { return plain }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
        guard let size, size <= PlainTextFile.readLimitBytes else { return .unreadable(bytes: size) }
        let type = url.pathExtension.lowercased()
        if type == "pdf", let document = PDFDocument(url: url), let text = document.string, !text.isEmpty {
            return .text(text, kind: .pdf, bytes: size)
        }
        let rich: [String: NSAttributedString.DocumentType] = ["rtf": .rtf, "rtfd": .rtfd, "docx": .officeOpenXML, "doc": .docFormat, "odt": .openDocument, "html": .html, "htm": .html, "webarchive": .webArchive]
        if let documentType = rich[type],
           let text = try? NSAttributedString(url: url, options: [.documentType: documentType], documentAttributes: nil).string,
           !text.isEmpty {
            return .text(text, kind: documentType == .officeOpenXML || documentType == .docFormat ? .word : .text, bytes: size)
        }
        return .unreadable(bytes: size)
    }
}
#endif
