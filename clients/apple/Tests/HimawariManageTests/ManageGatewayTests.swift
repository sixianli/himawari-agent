import Foundation
import XCTest
@testable import HimawariManage

private actor RecordingTransport: DeviceTransport {
    struct Call: Sendable {
        let path: String
        let body: [String: JSONValue]
        let nonce: String?
        let confirm: ConfirmPrompt?
    }

    private(set) var calls: [Call] = []
    private let responses: [String: DeviceResponse]

    init(responses: [String: DeviceResponse]) {
        self.responses = responses
    }

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        let decoded = try JSONDecoder().decode([String: JSONValue].self, from: json)
        return await record(Call(path: path, body: decoded, nonce: nonce, confirm: confirm))
    }

    private func record(_ call: Call) -> DeviceResponse {
        calls.append(call)
        return responses[call.path] ?? DeviceResponse(status: 200, body: Data("{}".utf8))
    }
}

final class ManageGatewayTests: XCTestCase {
    private func gateway(_ transport: RecordingTransport) -> ManageGateway {
        ManageGateway(transport: transport, makeIdentifier: { "0123456789abcdef0123" })
    }

    private func transport(gatewayStatus: Int = 200, gatewayBody: String = "{}") -> RecordingTransport {
        RecordingTransport(responses: [
            ManageGateway.challengePath: DeviceResponse(
                status: 201,
                body: Data(#"{"challenge":"server-issued-challenge-value","expiresAt":"2026-11-12T00:00:30.000Z"}"#.utf8)
            ),
            ManageGateway.gatewayPath: DeviceResponse(status: gatewayStatus, body: Data(gatewayBody.utf8)),
        ])
    }

    func testReadIsSignedByTheDeviceKeyOnly() async throws {
        let recording = transport()
        _ = try await gateway(recording).read(.v2, "memory.overview.read")
        let calls = await recording.calls
        XCTAssertEqual(calls.map(\.path), [ManageGateway.gatewayPath])
        XCTAssertNil(calls[0].nonce)
        XCTAssertNil(calls[0].confirm)
        XCTAssertEqual(calls[0].body["type"], "memory.overview.read")
        XCTAssertNil(calls[0].body["idempotencyKey"])
        XCTAssertNil(calls[0].body["scope"])
    }

    func testACommandKeepsTheCallersKeySoARetryIsNotRunTwice() async throws {
        let recording = transport()
        for _ in 0..<2 {
            _ = try await gateway(recording).command(
                .v2, "memory.settings.set", payload: ["capturePaused": true], options: ManageCommandOptions(confirmReason: "暂停", idempotencyKey: "device-option-abc")
            )
        }
        _ = try await gateway(recording).command(
            .v2, "memory.settings.set", payload: ["capturePaused": true], options: ManageCommandOptions(confirmReason: "暂停")
        )
        let calls = await recording.calls
        XCTAssertEqual(calls.map { $0.body["idempotencyKey"] }, [.string("device-option-abc"), .string("device-option-abc"), .string("device-0123456789abcdef0123")])
    }

    func testPausingSkipsFaceIDButResumingAsksForIt() async throws {
        let pause = transport()
        _ = try await gateway(pause).command(
            .v2, "memory.settings.set", payload: ["capturePaused": true], options: ManageCommandOptions(confirmReason: "恢复")
        )
        let pauseCalls = await pause.calls
        XCTAssertEqual(pauseCalls.map(\.path), [ManageGateway.gatewayPath])
        XCTAssertNil(pauseCalls[0].confirm)

        let resume = transport()
        _ = try await gateway(resume).command(
            .v2, "memory.settings.set", payload: ["capturePaused": false], options: ManageCommandOptions(confirmReason: "恢复")
        )
        let resumeCalls = await resume.calls
        XCTAssertEqual(resumeCalls.map(\.path), [ManageGateway.challengePath, ManageGateway.gatewayPath])
        XCTAssertEqual(resumeCalls[1].nonce, "server-issued-challenge-value")
        XCTAssertEqual(resumeCalls[1].confirm, ConfirmPrompt(reason: "恢复"))
    }

    func testChangeAlwaysUsesAFreshChallengeAndConfirmSignature() async throws {
        let recording = transport()
        _ = try await gateway(recording).command(
            .v2, "memory.rule.respond", payload: [:], options: ManageCommandOptions(confirmReason: "改规则")
        )
        let calls = await recording.calls
        XCTAssertEqual(calls.map(\.path), [ManageGateway.challengePath, ManageGateway.gatewayPath])
        XCTAssertNotNil(calls[1].confirm)
        XCTAssertEqual(calls[1].body["idempotencyKey"], "device-0123456789abcdef0123")
    }

    func testRefusesWhatThePhoneDoesNotDoWithoutTouchingTheNetwork() async throws {
        let recording = transport()
        do {
            _ = try await gateway(recording).command(
                .v2, "presence.heartbeat", payload: [:], options: ManageCommandOptions(confirmReason: "x")
            )
            XCTFail("expected notOnPhone")
        } catch let error as ManageGatewayError {
            XCTAssertEqual(error, .notOnPhone("presence.heartbeat"))
        }
        let calls = await recording.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testRoutineThreadActionsSkipFaceID() async throws {
        let recording = transport()
        _ = try await gateway(recording).command(
            .threadV3, "thread.pin",
            payload: ["threadId": "thread-1", "expectedRevision": 3, "pinOrder": 1, "resultRef": "ref-1"],
            options: ManageCommandOptions(confirmReason: "置顶")
        )
        let calls = await recording.calls
        XCTAssertEqual(calls.map(\.path), [ManageGateway.gatewayPath])
        XCTAssertNil(calls[0].confirm)
        XCTAssertNil(calls[0].body["dataClassification"])
        XCTAssertNil(calls[0].body["risk"])
    }

    func testPausingRemindersIsATightenButChangingTheirSettingsAsksForFaceID() async throws {
        let pause = transport()
        _ = try await gateway(pause).command(
            .v2, "proactive.pause", payload: [:], options: ManageCommandOptions(confirmReason: "暂停提醒")
        )
        let pauseCalls = await pause.calls
        XCTAssertEqual(pauseCalls.map(\.path), [ManageGateway.gatewayPath])

        let settings = transport()
        _ = try await gateway(settings).command(
            .v2, "proactive.settings.set",
            payload: ["enabled": false, "quietHours": [], "importantSenders": []],
            options: ManageCommandOptions(confirmReason: "改提醒设置")
        )
        let settingsCalls = await settings.calls
        XCTAssertEqual(settingsCalls.map(\.path), [ManageGateway.challengePath, ManageGateway.gatewayPath])
    }

    func testTurningOnePushKindOffSkipsFaceIDButTurningItOnAsksForIt() async throws {
        let off = transport()
        _ = try await gateway(off).command(
            .v2, "push.kind.set", payload: ["kind": "run", "enabled": false],
            options: ManageCommandOptions(confirmReason: "关推送")
        )
        let offCalls = await off.calls
        XCTAssertEqual(offCalls.map(\.path), [ManageGateway.gatewayPath])

        for payload: JSONValue in [["kind": "run", "enabled": true], ["kind": "run"], ["kind": "run", "enabled": "false"], ["enabled": false]] {
            let on = transport()
            _ = try await gateway(on).command(
                .v2, "push.kind.set", payload: payload, options: ManageCommandOptions(confirmReason: "开推送")
            )
            let onCalls = await on.calls
            XCTAssertEqual(onCalls.map(\.path), [ManageGateway.challengePath, ManageGateway.gatewayPath])
        }
    }

    func testRejectingExternalMemoriesSkipsFaceIDButKeepingOrEditingOneAsksForIt() async throws {
        let reject: JSONValue = ["proposalId": "a", "decision": "reject", "editedText": nil]
        let off = transport()
        _ = try await gateway(off).command(
            .v2, "memory.external.respond", payload: ["items": [reject, reject]],
            options: ManageCommandOptions(confirmReason: "拒绝")
        )
        let offCalls = await off.calls
        XCTAssertEqual(offCalls.map(\.path), [ManageGateway.gatewayPath])

        let keep: JSONValue = ["proposalId": "b", "decision": "keep", "editedText": nil]
        let edited: JSONValue = ["proposalId": "c", "decision": "reject", "editedText": "改过"]
        let missing: JSONValue = ["proposalId": "d", "decision": "reject"]
        let extra: JSONValue = ["proposalId": "e", "decision": "reject", "editedText": nil, "note": "x"]
        let payloads: [JSONValue] = [
            ["items": [reject, keep]],
            ["items": [edited]],
            ["items": [missing]],
            ["items": [extra]],
            ["items": []],
            ["items": reject],
            ["items": [reject], "extra": true],
            [:],
        ]
        for payload in payloads {
            let asked = transport()
            _ = try await gateway(asked).command(
                .v2, "memory.external.respond", payload: payload, options: ManageCommandOptions(confirmReason: "留下")
            )
            let askedCalls = await asked.calls
            XCTAssertEqual(askedCalls.map(\.path), [ManageGateway.challengePath, ManageGateway.gatewayPath], "\(payload)")
        }
    }

    func testDeviceAndExportTypesAreRegisteredAtTheirTiers() {
        for type in ["device.list.read", "server.status.read", "login.devices.read", "files.list.read", "data.export.status.read"] {
            XCTAssertEqual(ClientCapabilities.find(.v2, type)?.tier, .read, type)
        }
        for type in ["device.pairing.start", "device.pairing.confirm", "device.rename", "device.revoke", "login.device.revoke", "login.devices.revoke_others", "data.export.start"] {
            XCTAssertEqual(ClientCapabilities.find(.v2, type)?.tier, .change, type)
        }
        XCTAssertEqual(ClientCapabilities.find(.v2, "data.export.cancel")?.tier, .routine)
    }

    func testServerFilledReferencesAlwaysCarryThePlaceholder() async throws {
        let recording = transport()
        _ = try await gateway(recording).command(
            .threadV3, "thread.delete_permanently",
            payload: [
                "threadId": "thread-1",
                "expectedRevision": 3,
                "reasonCode": "OWNER_REQUESTED",
                "authorizationRef": nil,
                "recentAuthenticationRef": "guessed",
                "resultRef": "ref-1",
            ],
            options: ManageCommandOptions(confirmReason: "永久删除")
        )
        let calls = await recording.calls
        guard case .object(let payload)? = calls.last?.body["payload"] else { return XCTFail("payload missing") }
        XCTAssertEqual(payload["authorizationRef"], "device")
        XCTAssertEqual(payload["recentAuthenticationRef"], "device")
        XCTAssertNotNil(calls.last?.confirm)
    }

    func testServerRejectionCarriesItsCode() async throws {
        let recording = transport(gatewayStatus: 403, gatewayBody: #"{"error":{"code":"DEVICE_GATEWAY_CONFIRM_REQUIRED"}}"#)
        do {
            _ = try await gateway(recording).read(.v2, "memory.rules.read")
            XCTFail("expected rejection")
        } catch let error as ManageGatewayError {
            XCTAssertEqual(error, .rejected(status: 403, code: "DEVICE_GATEWAY_CONFIRM_REQUIRED"))
        }
    }
}
