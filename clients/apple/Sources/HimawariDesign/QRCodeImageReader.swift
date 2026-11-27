#if canImport(Vision) && canImport(ImageIO)
import Foundation
import ImageIO
import Vision

public enum QRCodeImageReader {
    public static func payloads(in data: Data) async -> [String] {
        await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else { return [String]() }
            let request = VNDetectBarcodesRequest()
            request.symbologies = [.qr]
            do {
                try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            } catch {
                return [String]()
            }
            return (request.results ?? []).compactMap(\.payloadStringValue)
        }.value
    }
}
#endif
