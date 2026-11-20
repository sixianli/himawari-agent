import Foundation
import Testing
@testable import HimawariCore

@Suite struct PairingTests {
    private func uri(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object)
        return "himawari-pair:" + data.base64URLEncodedString()
    }

    @Test func pairingNumberMatchesFixedVector() throws {
        let vectors = try SignatureVectors.load()
        let device = try #require(Data(base64Encoded: vectors.device.spki))
        let confirm = try #require(Data(base64Encoded: vectors.confirm.spki))
        #expect(PairingNumber.digits(devicePublicKey: device, confirmPublicKey: confirm) == vectors.pairingNumber)
        let display = PairingNumber.display(devicePublicKey: device, confirmPublicKey: confirm)
        #expect(display == "\(vectors.pairingNumber.prefix(3)) \(vectors.pairingNumber.suffix(3))")
    }

    @Test func pairingNumberChangesWhenEitherKeyChanges() throws {
        let vectors = try SignatureVectors.load()
        let device = try #require(Data(base64Encoded: vectors.device.spki))
        let confirm = try #require(Data(base64Encoded: vectors.confirm.spki))
        let other = try SoftwareKeySigner().publicKeySPKI()
        let original = PairingNumber.digits(devicePublicKey: device, confirmPublicKey: confirm)
        #expect(PairingNumber.digits(devicePublicKey: device, confirmPublicKey: other) != original)
        #expect(PairingNumber.digits(devicePublicKey: other, confirmPublicKey: confirm) != original)
        #expect(PairingNumber.digits(devicePublicKey: confirm, confirmPublicKey: device) != original)
    }

    @Test func pairingNumberIsZeroPadded() {
        for seed in 0..<200 {
            let digits = PairingNumber.digits(devicePublicKey: Data([UInt8(seed)]), confirmPublicKey: Data())
            #expect(digits.count == 6)
            #expect(digits.allSatisfy { $0.isNumber })
        }
    }

    @Test func parsesServerPairingUri() throws {
        let invitation = try PairingInvitation.parse(try uri(["v": 1, "origin": "https://himawari.example.test", "code": "abcdefghijklmnopqrstuv"]))
        #expect(invitation.origin.absoluteString == "https://himawari.example.test")
        #expect(invitation.code == "abcdefghijklmnopqrstuv")
        #expect(invitation.access == nil)
    }

    @Test func parsesOptionalAccessToken() throws {
        let invitation = try PairingInvitation.parse(try uri([
            "v": 1,
            "origin": "https://himawari.example.test",
            "code": "abcdefghijklmnopqrstuv",
            "access": ["clientId": "id.access", "clientSecret": "s3cr3t"],
        ]))
        #expect(invitation.access == ServiceAccessToken(clientId: "id.access", secret: "s3cr3t"))
    }

    @Test func rejectsWrongSchemeVersionOriginAndCode() throws {
        #expect(throws: PairingInvitation.ParseError.notAPairingCode) { try PairingInvitation.parse("https://example.test") }
        #expect(throws: PairingInvitation.ParseError.malformed) { try PairingInvitation.parse("himawari-pair:%%%") }
        #expect(throws: PairingInvitation.ParseError.unsupportedVersion) {
            try PairingInvitation.parse(try uri(["v": 2, "origin": "https://a.test", "code": "abcdefghijklmnopqrstuv"]))
        }
        #expect(throws: PairingInvitation.ParseError.malformed) {
            try PairingInvitation.parse(try uri(["v": 1, "origin": "http://a.test", "code": "abcdefghijklmnopqrstuv"]))
        }
        #expect(throws: PairingInvitation.ParseError.malformed) {
            try PairingInvitation.parse(try uri(["v": 1, "origin": "https://a.test/evil", "code": "abcdefghijklmnopqrstuv"]))
        }
        #expect(throws: PairingInvitation.ParseError.malformed) {
            try PairingInvitation.parse(try uri(["v": 1, "origin": "https://a.test", "code": "short"]))
        }
        for origin in ["https://user:pass@a.test", "https://user@a.test", "https://a.test/?next=b", "https://a.test/#x", "https:///"] {
            #expect(throws: PairingInvitation.ParseError.malformed) {
                try PairingInvitation.parse(try uri(["v": 1, "origin": origin, "code": "abcdefghijklmnopqrstuv"]))
            }
        }
    }

    @Test func aLinkMadeOnThisPhoneIsReadBackByTheNewDevice() throws {
        let access = try JSONDecoder().decode(
            ServiceAccessToken.self,
            from: Data(#"{"clientId":"id.access","clientSecret":"s3cret"}"#.utf8)
        )
        for origin in ["https://himawari.example.com", "https://himawari.example.com/"] {
            let invitation = PairingInvitation(origin: try #require(URL(string: origin)), code: PairingInvitation.newCode(), access: access)
            let parsed = try PairingInvitation.parse(invitation.link)
            #expect(parsed.code == invitation.code)
            #expect(parsed.access == access)
            #expect(parsed.origin.host == "himawari.example.com")
        }
        let bare = PairingInvitation(origin: try #require(URL(string: "https://h.example")), code: PairingInvitation.newCode(), access: nil)
        #expect(try PairingInvitation.parse(bare.link).access == nil)
    }

    @Test func newCodesAreTheCanonicalSixteenByteEncoding() {
        for _ in 0..<64 {
            #expect(PairingInvitation.newCode().range(of: "^[A-Za-z0-9_-]{21}[AQgw]$", options: .regularExpression) != nil)
        }
    }
}
