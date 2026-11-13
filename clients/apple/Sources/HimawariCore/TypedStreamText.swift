import Foundation

public enum TypedStreamText {
    static let header = Array("streamtyped".utf8)
    static let stringClasses = [Array("NSString".utf8), Array("NSMutableString".utf8)]
    static let bytesMarker: [UInt8] = [0x84, 0x01, 0x2B]
    static let markerWindow = 16

    public static func string(_ data: Data) -> String? {
        let bytes = [UInt8](data)
        guard firstIndex(of: header, in: bytes, from: 0, before: min(bytes.count, header.count + 2)) != nil else { return nil }
        let classEnds = stringClasses.compactMap { name in firstIndex(of: name, in: bytes, from: 0, before: bytes.count).map { $0 + name.count } }
        guard let classEnd = classEnds.min(),
              let marker = firstIndex(of: bytesMarker, in: bytes, from: classEnd, before: min(bytes.count, classEnd + markerWindow + bytesMarker.count))
        else { return nil }
        var cursor = marker + bytesMarker.count
        guard let length = readLength(bytes, &cursor), length > 0, length <= bytes.count - cursor else { return nil }
        return String(bytes: bytes[cursor ..< cursor + length], encoding: .utf8)
    }

    static func readLength(_ bytes: [UInt8], _ cursor: inout Int) -> Int? {
        guard cursor < bytes.count else { return nil }
        let tag = bytes[cursor]
        cursor += 1
        switch tag {
        case 0x81: return littleEndian(bytes, &cursor, width: 2)
        case 0x82: return littleEndian(bytes, &cursor, width: 4)
        case 0x00 ..< 0x80: return Int(tag)
        default: return nil
        }
    }

    static func littleEndian(_ bytes: [UInt8], _ cursor: inout Int, width: Int) -> Int? {
        guard width <= bytes.count - cursor else { return nil }
        var value = 0
        for offset in 0 ..< width { value |= Int(bytes[cursor + offset]) << (8 * offset) }
        cursor += width
        return value
    }

    static func firstIndex(of needle: [UInt8], in bytes: [UInt8], from start: Int, before end: Int) -> Int? {
        guard !needle.isEmpty, start >= 0, end - start >= needle.count else { return nil }
        for index in start ... (end - needle.count) where bytes[index] == needle[0] && Array(bytes[index ..< index + needle.count]) == needle {
            return index
        }
        return nil
    }
}
