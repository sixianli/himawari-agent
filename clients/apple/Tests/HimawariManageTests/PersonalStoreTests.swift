import Foundation
import HimawariCore
import XCTest
@testable import HimawariManage

private actor PreferencesServer: DeviceTransport {
    private(set) var sent: [[String: JSONValue]] = []
    private(set) var confirms: [String] = []
    private var revision = 4
    private var stored: [String: JSONValue] = [
        "name": .string("Andy"),
        "locale": .string("zh-CN"),
        "accent": .string("teal"),
        "theme": .string("dark"),
        "modelRef": .null,
        "thinkingLevel": .null,
    ]

    nonisolated func post(path: String, json: Data, nonce: String?, confirm: ConfirmPrompt?) async throws -> DeviceResponse {
        if path == ManageGateway.challengePath {
            return DeviceResponse(status: 201, body: Data(#"{"challenge":"c","expiresAt":"2026-11-26T00:00:30.000Z"}"#.utf8))
        }
        let body = try JSONDecoder().decode([String: JSONValue].self, from: json)
        return try await answer(body, confirm: confirm)
    }

    private func answer(_ body: [String: JSONValue], confirm: ConfirmPrompt?) throws -> DeviceResponse {
        sent.append(body)
        if let confirm { confirms.append(confirm.reason) }
        if body["type"] == .string("owner.preferences.set"), case .object(var fields)? = body["payload"] {
            fields.removeValue(forKey: "expectedRevision")
            stored = fields
            revision += 1
        }
        var payload = stored
        payload["revision"] = .number(Double(revision))
        payload["updatedAt"] = .string("2026-11-26T08:00:00.000Z")
        let encoded = try JSONEncoder().encode(JSONValue.object(["payload": .object(payload)]))
        return DeviceResponse(status: 200, body: encoded)
    }
}

private let models = ChatModels(defaultRef: "main", options: [
    ChatModel(ref: "main", name: "himawari-main", provider: "magpie", thinkingLevels: ["off", "low", "medium", "high"], automatic: true),
    ChatModel(ref: "flash", name: "DeepSeek V4.1 Flash", provider: "magpie", thinkingLevels: ["off", "high"]),
])

@MainActor
final class PersonalStoreTests: XCTestCase {
    private func store(_ server: PreferencesServer, models listed: ChatModels? = models) -> PersonalStore {
        PersonalStore(
            gateway: ManageGateway(transport: server, makeIdentifier: { "0123456789abcdef0123" }),
            loadModels: { listed }
        )
    }

    func testLoadingShowsTheSavedNameAndTheServerDefaultModel() async {
        let personal = store(PreferencesServer())
        await personal.load()
        XCTAssertEqual(personal.phase, .loaded)
        XCTAssertEqual(personal.name, "Andy")
        XCTAssertEqual(personal.chosenModel?.ref, "main")
        XCTAssertEqual(personal.chosenModel.flatMap(personal.thinkingLevel(for:)), "medium")
        XCTAssertTrue(personal.canChooseModel)
    }

    func testRenamingKeepsEveryOtherSettingAndSendsTheRevisionItRead() async throws {
        let server = PreferencesServer()
        let personal = store(server)
        await personal.load()
        try await personal.setName("  小安  ", reason: "你的称呼")
        let command = await server.sent.first { $0["type"] == .string("owner.preferences.set") }
        XCTAssertEqual(command?["payload"], .object([
            "name": .string("小安"),
            "locale": .string("zh-CN"),
            "accent": .string("teal"),
            "theme": .string("dark"),
            "modelRef": .null,
            "thinkingLevel": .null,
            "expectedRevision": .number(4),
        ]))
        let confirms = await server.confirms
        XCTAssertEqual(confirms, ["你的称呼"])
        XCTAssertEqual(personal.name, "小安")
        XCTAssertEqual(personal.preferences?.revision, 5)
    }

    func testClearingTheNameSavesNoName() async throws {
        let server = PreferencesServer()
        let personal = store(server)
        await personal.load()
        try await personal.setName("   ", reason: "你的称呼")
        XCTAssertNil(personal.name)
    }

    func testChoosingAModelSavesItWithADepthThatModelHas() async throws {
        let server = PreferencesServer()
        let personal = store(server)
        await personal.load()
        let flash = try XCTUnwrap(models.options.last)
        try await personal.setModel(flash, thinkingLevel: "medium", reason: "她用的模型")
        let command = await server.sent.first { $0["type"] == .string("owner.preferences.set") }
        guard case .object(let fields)? = command?["payload"] else { return XCTFail("no command") }
        XCTAssertEqual(fields["modelRef"], .string("flash"))
        XCTAssertEqual(fields["thinkingLevel"], .string("high"))
        XCTAssertEqual(fields["name"], .string("Andy"))
        XCTAssertEqual(personal.chosenModel?.ref, "flash")
        XCTAssertEqual(personal.chosenModel.flatMap(personal.thinkingLevel(for:)), "high")
    }

    func testNoModelRowWhenTheServerOffersNothingToChoose() async {
        let single = ChatModels(defaultRef: "main", options: [
            ChatModel(ref: "main", name: "himawari-main", provider: "magpie", thinkingLevels: ["off"]),
        ])
        let one = store(PreferencesServer(), models: single)
        await one.load()
        XCTAssertFalse(one.canChooseModel)
        let none = store(PreferencesServer(), models: nil)
        await none.load()
        XCTAssertFalse(none.canChooseModel)
        XCTAssertEqual(none.phase, .loaded)
    }

    func testANameLongerThanTheServerTakesIsCut() {
        XCTAssertEqual(PersonalStore.cleanName(String(repeating: "向", count: 50))?.count, PersonalStore.nameLimit)
    }
}
