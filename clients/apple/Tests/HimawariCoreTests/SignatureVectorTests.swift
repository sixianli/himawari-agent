import Foundation
import Testing
@testable import HimawariCore

struct SignatureVectors: Decodable {
    struct Key: Decodable {
        let scalar: String
        let spki: String
    }

    struct Case: Decodable {
        let method: String
        let authority: String
        let path: String
        let rawQuery: String
        let body: String?
        let contentType: String?
        let deviceId: String
        let created: Int64
        let nonce: String
        let signatureBase: String
        let signatureInput: String
        let signature: String
        let contentDigest: String?
    }

    let device: Key
    let confirm: Key
    let pairingNumber: String
    let cases: [Case]

    static func load() throws -> SignatureVectors {
        let url = try #require(Bundle.module.url(forResource: "signature-vectors", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(SignatureVectors.self, from: Data(contentsOf: url))
    }
}

extension SignatureVectors.Case {
    var target: DeviceRequestTarget {
        DeviceRequestTarget(
            method: method,
            authority: authority,
            path: path,
            rawQuery: rawQuery,
            body: body.map { Data($0.utf8) },
            contentType: contentType
        )
    }

    var parameters: DeviceSignatureParameters {
        DeviceSignatureParameters(deviceId: deviceId, created: created, nonce: nonce)
    }
}

@Suite struct SignatureVectorTests {
    @Test func signatureBaseMatchesServerConstruction() throws {
        let vectors = try SignatureVectors.load()
        for vector in vectors.cases {
            #expect(DeviceSignature.signatureBase(target: vector.target, parameters: vector.parameters) == vector.signatureBase)
        }
    }

    @Test func serverSignatureVerifiesWithDevicePublicKey() throws {
        let vectors = try SignatureVectors.load()
        let spki = try #require(Data(base64Encoded: vectors.device.spki))
        for vector in vectors.cases {
            let signature = try #require(Data(base64Encoded: vector.signature))
            #expect(SoftwareKeySigner.verify(signature: signature, message: Data(vector.signatureBase.utf8), publicKeySPKI: spki))
        }
    }

    @Test func headersCarryLabelParamsAndDigest() async throws {
        let vectors = try SignatureVectors.load()
        let signer = try SoftwareKeySigner(rawRepresentation: try #require(Data(base64Encoded: vectors.device.scalar)))
        #expect(try signer.publicKeySPKI().base64EncodedString() == vectors.device.spki)
        for vector in vectors.cases {
            let headers = try await DeviceSignature.headers(target: vector.target, parameters: vector.parameters, signer: signer)
            #expect(headers["Signature-Input"] == vector.signatureInput)
            #expect(headers["Content-Digest"] == vector.contentDigest)
            let value = try #require(headers["Signature"])
            #expect(value.hasPrefix("device=:") && value.hasSuffix(":"))
            let signature = try #require(Data(base64Encoded: String(value.dropFirst("device=:".count).dropLast())))
            #expect(signature.count == 64)
            #expect(SoftwareKeySigner.verify(signature: signature, message: Data(vector.signatureBase.utf8), publicKeySPKI: try signer.publicKeySPKI()))
        }
    }

    @Test func tamperedBaseDoesNotVerify() throws {
        let vectors = try SignatureVectors.load()
        let spki = try #require(Data(base64Encoded: vectors.device.spki))
        let vector = try #require(vectors.cases.last)
        let signature = try #require(Data(base64Encoded: vector.signature))
        let tampered = vector.signatureBase.replacingOccurrences(of: "/messages", with: "/threads")
        #expect(!SoftwareKeySigner.verify(signature: signature, message: Data(tampered.utf8), publicKeySPKI: spki))
    }

    @Test func emptyBodyIsSignedWithoutBodyComponents() {
        let target = DeviceRequestTarget(method: "get", authority: "Example.TEST", path: "/p", rawQuery: "", body: Data(), contentType: "application/json")
        #expect(target.body == nil)
        #expect(target.contentType == nil)
        #expect(target.method == "GET")
        #expect(target.authority == "example.test")
        let base = DeviceSignature.signatureBase(target: target, parameters: DeviceSignatureParameters(deviceId: "dev_x", created: 1, nonce: "n"))
        #expect(!base.contains("content-digest"))
        #expect(base.contains("\"@query\": ?\n"))
    }
}
