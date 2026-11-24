import Foundation
import Testing
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
@testable import HimawariCore

struct VaultFixture: Decodable {
    struct Cases: Decodable {
        let accept: [String]
        let reject: [String]
    }

    struct OriginCases: Decodable {
        let accept: [[String]]
        let reject: [String]
    }

    struct FieldCase: Decodable {
        let kind: String
        let fields: [String]

        init(from decoder: Decoder) throws {
            var container = try decoder.unkeyedContainer()
            kind = try container.decode(String.self)
            fields = try container.decode([String].self)
        }
    }

    struct FieldCases: Decodable {
        let accept: [FieldCase]
        let reject: [FieldCase]
    }

    struct Vector: Decodable {
        struct Manifest: Decodable {
            let version: Int
            let signature: String
            let bytes: String
        }

        let masterKey: String
        let itemKey: String
        let item: VaultSealedItem
        let values: [String: String]
        let manifest: Manifest
    }

    struct TOTPCase: Decodable {
        let at: Int64
        let code: String

        init(from decoder: Decoder) throws {
            var container = try decoder.unkeyedContainer()
            at = try container.decode(Int64.self)
            code = try container.decode(String.self)
        }
    }

    struct TOTP: Decodable {
        let seed: String
        let codes: [TOTPCase]
    }

    let itemId: Cases
    let requestId: Cases
    let nonce: Cases
    let origin: OriginCases
    let name: Cases
    let fields: FieldCases
    let vector: Vector
    let totp: TOTP
    let phoneVector: PhoneVector

    struct PhoneVector: Decodable {
        let masterKey: String
        let item: VaultSealedItem
        let values: [String: String]
        let manifest: VaultManifestSignature
    }

    static func load() throws -> VaultFixture {
        let url = try #require(Bundle.module.url(forResource: "vault-contract", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(VaultFixture.self, from: Data(contentsOf: url))
    }
}

@Suite struct VaultContractTests {
    @Test func identifiersFollowTheSharedContract() throws {
        let fixture = try VaultFixture.load()
        for value in fixture.itemId.accept { #expect(VaultContract.isItemId(value), "\(value)") }
        for value in fixture.itemId.reject { #expect(!VaultContract.isItemId(value), "\(value)") }
        for value in fixture.requestId.accept { #expect(VaultContract.isRequestId(value), "\(value)") }
        for value in fixture.requestId.reject { #expect(!VaultContract.isRequestId(value), "\(value)") }
        for value in fixture.nonce.accept { #expect(VaultContract.isNonce(value), "\(value)") }
        for value in fixture.nonce.reject { #expect(!VaultContract.isNonce(value), "\(value)") }
        #expect(VaultContract.isItemId(VaultContract.newItemId()))
    }

    @Test func originsAndNamesFollowTheSharedContract() throws {
        let fixture = try VaultFixture.load()
        for pair in fixture.origin.accept { #expect(VaultContract.origin(pair[0]) == pair[1], "\(pair[0])") }
        for value in fixture.origin.reject { #expect(VaultContract.origin(value) == nil, "\(value)") }
        for value in fixture.name.accept { #expect(VaultContract.name(value) == value, "\(value)") }
        for value in fixture.name.reject { #expect(VaultContract.name(value) == nil, "\(value)") }
    }

    @Test func fieldSetsFollowTheSharedContract() throws {
        let fixture = try VaultFixture.load()
        for entry in fixture.fields.accept {
            let kind = try #require(VaultItemKind(rawValue: entry.kind))
            #expect(VaultContract.fieldsValid(kind: kind, fields: entry.fields), "\(entry.kind) \(entry.fields)")
        }
        for entry in fixture.fields.reject {
            let valid = VaultItemKind(rawValue: entry.kind).map { VaultContract.fieldsValid(kind: $0, fields: entry.fields) } ?? false
            #expect(!valid, "\(entry.kind) \(entry.fields)")
        }
    }

    @Test func opensTheServerVectorAndKeepsTheTwoStepSeedOutOfTheItemKey() throws {
        let vector = try VaultFixture.load().vector
        let keyring = try VaultKeyring(masterKey: try #require(Data(base64Encoded: vector.masterKey)))
        #expect(try keyring.itemKey(vector.item) == Data(base64Encoded: vector.itemKey))
        #expect(try keyring.open(vector.item).values == vector.values)
        let itemKey = SymmetricKey(data: try #require(Data(base64Encoded: vector.itemKey)))
        #expect(throws: (any Error).self) {
            _ = try VaultKeyring.openAESGCM(try #require(vector.item.ciphertexts["totp"]), key: itemKey, aad: VaultContract.fieldAAD(itemId: vector.item.id, field: "totp", version: vector.item.version))
        }
        #expect(throws: (any Error).self) {
            _ = try VaultKeyring.openAESGCM(try #require(vector.item.ciphertexts["password"]), key: itemKey, aad: VaultContract.fieldAAD(itemId: vector.item.id, field: "username", version: vector.item.version))
        }
    }

    @Test func signsTheSameManifestBytesAsTheServer() throws {
        let vector = try VaultFixture.load().vector
        let keyring = try VaultKeyring(masterKey: try #require(Data(base64Encoded: vector.masterKey)))
        #expect(String(decoding: VaultManifest.bytes(version: vector.manifest.version, items: [vector.item]), as: UTF8.self) == vector.manifest.bytes)
        let signature = keyring.manifestSignature(version: vector.manifest.version, items: [vector.item])
        #expect(signature.signature == vector.manifest.signature)
        #expect(keyring.manifestValid(signature, items: [vector.item]))
        #expect(!keyring.manifestValid(VaultManifestSignature(version: vector.manifest.version + 1, signature: signature.signature), items: [vector.item]))
        let other = try VaultKeyring(masterKey: VaultKeyring.newMasterKey())
        #expect(!other.manifestValid(signature, items: [vector.item]))
    }

    @Test func theCheckedInPhoneVectorStillOpensWithThePhoneCode() throws {
        let vector = try VaultFixture.load().phoneVector
        let keyring = try VaultKeyring(masterKey: try #require(Data(base64Encoded: vector.masterKey)))
        let opened = try keyring.open(vector.item)
        #expect(opened.values["password"] == vector.values["password"])
        #expect(opened.values["username"] == vector.values["username"])
        #expect(keyring.manifestValid(vector.manifest, items: [vector.item]))
    }

    @Test func computesRFC6238TwoStepCodes() throws {
        let totp = try VaultFixture.load().totp
        for entry in totp.codes { #expect(try VaultTOTP.code(base32Seed: totp.seed, at: entry.at) == entry.code, "\(entry.at)") }
        #expect(throws: VaultCryptoError.invalidTOTPSeed) { _ = try VaultTOTP.code(base32Seed: "not base32!", at: 0) }
    }

    @Test func sealedItemsRoundTripAndRefuseInvalidInput() throws {
        let keyring = try VaultKeyring(masterKey: VaultKeyring.newMasterKey())
        let id = VaultContract.newItemId()
        let values = VaultItemValues(name: "GitHub", kind: .login, origins: ["HTTPS://GitHub.com:443/"], values: ["password": "p", "username": "u"], backgroundAllowed: true)
        let sealed = try keyring.seal(id: id, item: values, version: 1)
        #expect(sealed.origins == ["https://github.com"])
        #expect(sealed.fields == ["password", "username"])
        #expect(try keyring.open(sealed).values == values.values)
        var missing = values
        missing.values = ["username": "u"]
        #expect(throws: VaultCryptoError.self) { _ = try keyring.seal(id: id, item: missing, version: 1) }
        var badOrigin = values
        badOrigin.origins = ["http://github.com"]
        #expect(throws: VaultCryptoError.self) { _ = try keyring.seal(id: id, item: badOrigin, version: 1) }
        var emptyPassword = values
        emptyPassword.values = ["password": "", "username": "u"]
        #expect(throws: VaultCryptoError.invalidField("password")) { _ = try keyring.seal(id: id, item: emptyPassword, version: 1) }
        var emptyUsername = values
        emptyUsername.values = ["password": "p", "username": ""]
        #expect(throws: VaultCryptoError.invalidField("username")) { _ = try keyring.seal(id: id, item: emptyUsername, version: 1) }
    }

    @Test func releasesTheItemKeyOnlyToTheRequestEphemeralKey() throws {
        let keyring = try VaultKeyring(masterKey: VaultKeyring.newMasterKey())
        let id = VaultContract.newItemId()
        let sealed = try keyring.seal(id: id, item: VaultItemValues(name: "Bank", kind: .login, origins: ["https://bank.example.com"], values: ["password": "p", "totp": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"], backgroundAllowed: false), version: 2)
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let request = VaultPendingRequest(
            id: "vr_AAAAAAAAAAAAAAAAAAAAAA",
            nonce: String(repeating: "n", count: 43),
            itemIds: [id],
            itemVersions: [2],
            origin: "https://bank.example.com",
            pageVersion: nil,
            ephemeralPublicKey: ephemeral.publicKey.x963Representation.base64EncodedString(),
            expiresAt: "2026-11-25T00:02:00.000Z",
            createdAt: "2026-11-25T00:00:00.000Z",
            purpose: "pay"
        )
        let releases = try keyring.release(request: request, items: [sealed], now: Date(timeIntervalSince1970: 59))
        let release = try #require(releases.first)
        var recipient = try HPKE.Recipient(
            privateKey: ephemeral,
            ciphersuite: .P256_SHA256_AES_GCM_256,
            info: VaultContract.releaseInfo,
            encapsulatedKey: try #require(Data(base64Encoded: release.enc))
        )
        let plain = try recipient.open(try #require(Data(base64Encoded: release.ciphertext)), authenticating: VaultContract.releaseAAD(requestId: request.id, itemId: id, version: 2))
        let object = try #require(try JSONSerialization.jsonObject(with: plain) as? [String: Any])
        #expect(object["itemKey"] as? String == (try keyring.itemKey(sealed)).base64EncodedString())
        let codes = try #require(object["totp"] as? [[String: Any]])
        #expect(codes.first?["code"] as? String == "287082")
        #expect(codes.count == 3)

        let wrongOrigin = VaultPendingRequest(id: request.id, nonce: request.nonce, itemIds: request.itemIds, itemVersions: request.itemVersions, origin: "https://evil.example.com", pageVersion: nil, ephemeralPublicKey: request.ephemeralPublicKey, expiresAt: request.expiresAt, createdAt: request.createdAt, purpose: request.purpose)
        #expect(throws: VaultCryptoError.originNotAllowed) { _ = try keyring.release(request: wrongOrigin, items: [sealed], now: Date()) }
        let staleVersion = VaultPendingRequest(id: request.id, nonce: request.nonce, itemIds: request.itemIds, itemVersions: [1], origin: request.origin, pageVersion: nil, ephemeralPublicKey: request.ephemeralPublicKey, expiresAt: request.expiresAt, createdAt: request.createdAt, purpose: request.purpose)
        #expect(throws: VaultCryptoError.unknownItem(id)) { _ = try keyring.release(request: staleVersion, items: [sealed], now: Date()) }
    }

    @Test func approvalBodyEncodesANullPageVersion() throws {
        let request = VaultPendingRequest(id: "vr_AAAAAAAAAAAAAAAAAAAAAA", nonce: String(repeating: "n", count: 43), itemIds: [], itemVersions: [], origin: "https://a.example", pageVersion: nil, ephemeralPublicKey: "k", expiresAt: "e", createdAt: "c", purpose: "p")
        let data = try JSONEncoder().encode(VaultApproval(request: request, deviceId: "dev_x", sealed: []))
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["pageVersion"] is NSNull)
        #expect(Set(object.keys) == ["requestId", "nonce", "deviceId", "itemIds", "itemVersions", "origin", "pageVersion", "ephemeralPublicKey", "expiresAt", "sealed"])
    }
}

@Suite struct VaultOTPAuthTests {
    @Test func readsTheSeedFromACommonQRCode() {
        #expect(VaultOTPAuth.seed(from: "otpauth://totp/GitHub:andy?secret=jbswy3dpehpk3pxp&issuer=GitHub") == "JBSWY3DPEHPK3PXP")
        #expect(VaultOTPAuth.seed(from: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30") == "JBSWY3DPEHPK3PXP")
    }

    @Test func refusesCodesThePhoneCannotComputeTheSameWay() {
        #expect(VaultOTPAuth.seed(from: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8") == nil)
        #expect(VaultOTPAuth.seed(from: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256") == nil)
        #expect(VaultOTPAuth.seed(from: "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1") == nil)
        #expect(VaultOTPAuth.seed(from: "otpauth://totp/x?secret=not-base32!") == nil)
        #expect(VaultOTPAuth.seed(from: "https://example.com") == nil)
    }
}
