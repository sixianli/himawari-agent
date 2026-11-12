import Foundation
import Testing
@testable import HimawariCore

@Suite struct PairingProblemTests {
    @Test func mapsServerPairingErrors() {
        #expect(PairingProblem.from(DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED")) == .codeExpired(ttlSeconds: nil))
        #expect(PairingProblem.from(DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED", pairingCodeTtlSeconds: 600)) == .codeExpired(ttlSeconds: 600))
        #expect(PairingProblem.from(DeviceAPIError.server(status: 410, code: "DEVICE_PAIRING_CODE_EXPIRED", pairingCodeTtlSeconds: 0)) == .codeExpired(ttlSeconds: nil))
        #expect(PairingProblem.from(DeviceAPIError.server(status: 409, code: "DEVICE_PAIRING_CODE_USED")) == .codeUsed)
        #expect(PairingProblem.from(DeviceAPIError.server(status: 403, code: "DEVICE_REVOKED")) == .removed)
        #expect(PairingProblem.from(DeviceAPIError.server(status: 404, code: "DEVICE_PAIRING_CODE_INVALID")) == .codeInvalid)
        #expect(PairingProblem.from(DeviceAPIError.server(status: 502, code: nil)) == .unreachable)
        #expect(PairingProblem.from(URLError(.notConnectedToInternet)) == .unreachable)
        #expect(PairingProblem.from(PairingInvitation.ParseError.notAPairingCode) == .unreadableCode)
        #expect(PairingProblem.from(DeviceKeyError.secureEnclaveUnavailable) == .keysUnavailable)
    }

    @Test func recordRoundTripsWithoutLosingTheNumber() throws {
        let record = PairingRecord(origin: URL(string: "https://a.test")!, deviceId: "dev_x", access: ServiceAccessToken(clientId: "i", secret: "s"), status: .pending, pairingNumber: "012345")
        let decoded = try JSONDecoder().decode(PairingRecord.self, from: JSONEncoder().encode(record))
        #expect(decoded == record)
    }
}

@Suite struct DeviceConfigurationTests {
    @Test func readsStreamConnectionsWhenTheServerSendsIt() throws {
        let base = #"{"heartbeatSeconds":15,"connectionMaxSeconds":300,"signatureToleranceSeconds":60,"limits":[]"#
        let with = try JSONDecoder().decode(DeviceConfiguration.self, from: Data((base + #","streamConnections":4}"#).utf8))
        let without = try JSONDecoder().decode(DeviceConfiguration.self, from: Data((base + "}").utf8))
        #expect(with.streamConnections == 4)
        #expect(without.streamConnections == nil)
    }
}
