#if canImport(VisionKit) && os(iOS)
import SwiftUI
import VisionKit

public struct QRCodeScanner: UIViewControllerRepresentable {
    private let accepts: (String) -> Bool
    private let found: (String) -> Void

    public init(accepts: @escaping (String) -> Bool, found: @escaping (String) -> Void) {
        self.accepts = accepts
        self.found = found
    }

    public static var available: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(accepts: accepts, found: found)
    }

    public func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: false
        )
        controller.delegate = context.coordinator
        return controller
    }

    public func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        if !controller.isScanning { try? controller.startScanning() }
    }

    public static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    @MainActor
    public final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let accepts: (String) -> Bool
        private let found: (String) -> Void
        private var delivered = false

        init(accepts: @escaping (String) -> Bool, found: @escaping (String) -> Void) {
            self.accepts = accepts
            self.found = found
        }

        public func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for item in addedItems {
                if case let .barcode(code) = item, let payload = code.payloadStringValue, accepts(payload) {
                    delivered = true
                    dataScanner.stopScanning()
                    found(payload)
                    return
                }
            }
        }
    }
}
#endif
