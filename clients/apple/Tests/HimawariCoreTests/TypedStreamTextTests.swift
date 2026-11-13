import Foundation
@testable import HimawariCore
import Testing
#if canImport(AppKit)
import AppKit
#endif

@Suite struct TypedStreamTextTests {
    static func blob(_ text: String, className: String = "NSString", length: [UInt8]? = nil, tail: [UInt8] = [0x86, 0x84, 0x02, 0x69, 0x49]) -> Data {
        let utf8 = Array(text.utf8)
        var bytes: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8) + [0x81, 0xE8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]
        bytes += Array("NSAttributedString".utf8) + [0x00, 0x84, 0x84, 0x08] + Array("NSObject".utf8) + [0x00, 0x85, 0x92, 0x84, 0x84, 0x84, UInt8(className.utf8.count)]
        bytes += Array(className.utf8) + [0x01, 0x94, 0x84, 0x01, 0x2B]
        if let length {
            bytes += length
        } else if utf8.count < 0x80 {
            bytes.append(UInt8(utf8.count))
        } else {
            bytes += [0x81, UInt8(utf8.count & 0xFF), UInt8(utf8.count >> 8)]
        }
        return Data(bytes + utf8 + tail)
    }

    @Test func aShortMessageIsReadFromTheArchivedString() {
        #expect(TypedStreamText.string(Self.blob("Hello")) == "Hello")
        #expect(TypedStreamText.string(Self.blob("周五的会改到 15:00 😀")) == "周五的会改到 15:00 😀")
        #expect(TypedStreamText.string(Self.blob("x", className: "NSMutableString")) == "x")
    }

    @Test func aLongMessageUsesTheTwoByteLength() {
        let text = String(repeating: "长", count: 300)
        #expect(TypedStreamText.string(Self.blob(text)) == text)
    }

    @Test func brokenOrForeignDataGivesNothingInsteadOfCrashing() {
        #expect(TypedStreamText.string(Data()) == nil)
        #expect(TypedStreamText.string(Data("NSString".utf8)) == nil)
        #expect(TypedStreamText.string(Self.blob("Hello", length: [0x7F], tail: [])) == nil)
        #expect(TypedStreamText.string(Self.blob("Hello", length: [0x81, 0xFF])) == nil)
        #expect(TypedStreamText.string(Self.blob("Hello", length: [0x82, 0xFF, 0xFF, 0xFF, 0x7F])) == nil)
        #expect(TypedStreamText.string(Self.blob("Hello", length: [0x85])) == nil)
        var invalid = [UInt8](Self.blob("ab"))
        invalid[invalid.count - 7] = 0xFF
        #expect(TypedStreamText.string(Data(invalid)) == nil)
        let full = Self.blob("Hello")
        for cut in 0 ..< full.count {
            #expect(TypedStreamText.string(full.prefix(cut)) == nil || cut >= full.count - 5)
        }
    }

    #if canImport(AppKit)
    @Test func whatTheSystemArchiverWritesIsReadBack() throws {
        for text in ["Hello", "周五的会改到 15:00 😀", String(repeating: "长", count: 300)] {
            let data = NSArchiver.archivedData(withRootObject: NSAttributedString(string: text))
            #expect(TypedStreamText.string(data) == text)
        }
    }
    #endif
}
