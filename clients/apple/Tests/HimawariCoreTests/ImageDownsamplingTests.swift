#if canImport(ImageIO) && canImport(CoreGraphics)
import CoreGraphics
import Foundation
@testable import HimawariCore
import ImageIO
import Testing
import UniformTypeIdentifiers

@Suite struct ImageDownsamplingTests {
    private func png(width: Int, height: Int) throws -> Data {
        let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0.5, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        let output = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        return output as Data
    }

    private func pixels(_ data: Data) throws -> (width: Int, height: Int) {
        let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        return (try #require(properties[kCGImagePropertyPixelWidth] as? Int), try #require(properties[kCGImagePropertyPixelHeight] as? Int))
    }

    @Test func aHugeImageIsDecodedNoLargerThanTheCap() throws {
        let jpeg = try #require(ImageDownsampling.jpeg(try png(width: 8000, height: 2000), maxPixels: 1000, quality: 0.85))
        let size = try pixels(jpeg)
        #expect(size.width == 1000)
        #expect(size.height == 250)
    }

    @Test func aSmallImageKeepsItsSize() throws {
        let jpeg = try #require(ImageDownsampling.jpeg(try png(width: 300, height: 200), maxPixels: 1000, quality: 0.85))
        let size = try pixels(jpeg)
        #expect(size.width == 300)
        #expect(size.height == 200)
    }

    @Test func dataThatIsNotAnImageIsRefused() {
        #expect(ImageDownsampling.jpeg(Data("not an image".utf8), quality: 0.85) == nil)
    }
}
#endif
