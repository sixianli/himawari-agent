import CoreGraphics
import Foundation
import ImageIO

struct Bitmap {
    let width: Int
    let height: Int
    let bytes: [UInt8]
}

func load(_ url: URL) -> Bitmap? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    let width = image.width
    let height = image.height
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(
            data: buffer.baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    return drawn ? Bitmap(width: width, height: height, bytes: bytes) : nil
}

let channelTolerance = 3
let allowedChangedShare = 0.0005
let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: compare-snapshots.swift <approved-dir> <fresh-dir>\n".utf8))
    exit(2)
}
let approvedDirectory = URL(fileURLWithPath: arguments[1])
let freshDirectory = URL(fileURLWithPath: arguments[2])
let approved = ((try? FileManager.default.contentsOfDirectory(atPath: approvedDirectory.path)) ?? []).filter { $0.hasSuffix(".png") }.sorted()
guard !approved.isEmpty else {
    print("SNAPSHOT_FAILED no approved snapshots in \(approvedDirectory.path)")
    exit(1)
}
var failures = 0
for name in approved {
    guard let expected = load(approvedDirectory.appendingPathComponent(name)) else {
        print("SNAPSHOT_UNREADABLE \(name)")
        failures += 1
        continue
    }
    guard let actual = load(freshDirectory.appendingPathComponent(name)) else {
        print("SNAPSHOT_MISSING \(name)")
        failures += 1
        continue
    }
    guard expected.width == actual.width, expected.height == actual.height else {
        print("SNAPSHOT_SIZE \(name) \(expected.width)x\(expected.height) -> \(actual.width)x\(actual.height)")
        failures += 1
        continue
    }
    var changed = 0
    for pixel in stride(from: 0, to: expected.bytes.count, by: 4) {
        for channel in 0..<3 where abs(Int(expected.bytes[pixel + channel]) - Int(actual.bytes[pixel + channel])) > channelTolerance {
            changed += 1
            break
        }
    }
    let share = Double(changed) / Double(expected.width * expected.height)
    if share > allowedChangedShare {
        print("SNAPSHOT_DIFF \(name) changed=\(String(format: "%.4f", share))")
        failures += 1
    } else {
        print("SNAPSHOT_OK \(name) changed=\(String(format: "%.4f", share))")
    }
}
if failures > 0 {
    print("SNAPSHOT_FAILED \(failures) of \(approved.count)")
    exit(1)
}
print("SNAPSHOT_PASSED \(approved.count)")
