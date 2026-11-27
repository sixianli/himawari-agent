import Foundation
import Testing

@testable import HimawariCore

final class FakeApprovalTransport: ApprovalPushTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var tokens: [String] = []

    func respondToApproval(token: String) async throws {
        lock.withLock { tokens.append(token) }
    }
}

@Suite struct ApprovalPushTests {
    private func serverPayload(ownerPresence: Bool) throws -> [AnyHashable: Any] {
        let json = """
        {"aps":{"alert":{"title":"要你同意","body":"付 12,800 日元订 ANA 123"},"sound":"default","thread-id":"approval","mutable-content":1,"interruption-level":"time-sensitive","category":"himawari.actions"},
         "notificationId":"tag-1",
         "himawari":{"v":1,"tag":"tag-1","kind":"approval","navigate":"/approvals/a1","actions":[
           {"action":"approve","label":"\(ownerPresence ? "看内容再定" : "付钱")","labelBasis":"model","polarity":"positive","token":"approve-token","ownerPresence":\(ownerPresence)},
           {"action":"deny","label":"不同意","labelBasis":"catalog","polarity":"negative","token":"deny-token","ownerPresence":false}]}}
        """
        return try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [AnyHashable: Any])
    }

    @Test func readsTheServersButtonsInOrder() throws {
        let push = try #require(HimawariPush(userInfo: try serverPayload(ownerPresence: false)))
        #expect(push.kind == "approval")
        #expect(push.actions.map(\.action) == [.approve, .deny])
        #expect(push.actions.map(\.label) == ["付钱", "不同意"])
        #expect(push.actions.first?.ownerPresence == false)
    }

    @Test func aTapSendsOnlyThatButtonsToken() async throws {
        let transport = FakeApprovalTransport()
        let push = try #require(HimawariPush(userInfo: try serverPayload(ownerPresence: false)))
        let outcome = try await ApprovalPushReply(transport: transport).tap(.deny, in: push)
        #expect(outcome == .sent)
        #expect(transport.tokens == ["deny-token"])
    }

    @Test func anApprovalThatNeedsTheOwnerOpensTheAppAndSendsNothing() async throws {
        let transport = FakeApprovalTransport()
        let push = try #require(HimawariPush(userInfo: try serverPayload(ownerPresence: true)))
        let outcome = try await ApprovalPushReply(transport: transport).tap(.approve, in: push)
        #expect(outcome == .openApp)
        #expect(transport.tokens.isEmpty)
    }

    @Test func aButtonThatDoesNotSayWhetherTheOwnerMustBeThereOpensTheApp() async throws {
        let userInfo: [AnyHashable: Any] = ["himawari": ["v": 1, "kind": "approval", "actions": [["action": "approve", "label": "付钱", "token": "approve-token"]]]]
        let push = try #require(HimawariPush(userInfo: userInfo))
        #expect(push.action(.approve)?.ownerPresence == true)
        let transport = FakeApprovalTransport()
        #expect(try await ApprovalPushReply(transport: transport).tap(.approve, in: push) == .openApp)
        #expect(transport.tokens.isEmpty)
    }

    @Test func aPushWithoutButtonsOrFromElsewhereIsNotAnApproval() async throws {
        let plain: [AnyHashable: Any] = ["aps": ["alert": ["title": "她", "body": "到家了吗"], "category": "himawari.plain"], "himawari": ["v": 1, "tag": "t", "kind": "reply", "navigate": "/", "actions": []]]
        let push = try #require(HimawariPush(userInfo: plain))
        #expect(push.actions.isEmpty)
        let transport = FakeApprovalTransport()
        #expect(try await ApprovalPushReply(transport: transport).tap(.approve, in: push) == .openApp)
        #expect(transport.tokens.isEmpty)
        #expect(HimawariPush(userInfo: ["aps": ["alert": "x"]]) == nil)
        #expect(HimawariPush(userInfo: ["himawari": ["v": 2, "kind": "approval", "actions": []]]) == nil)
    }
}

@Suite struct VaultCodePushTests {
    @Test func readsTheCodeRequestTheServerPushes() throws {
        let json = """
        {"aps":{"alert":{"title":"Himawari 需要一个验证码","body":"招商银行发到你手机的短信验证码（bank.example.com）"},"sound":"default","thread-id":"vault_code","interruption-level":"time-sensitive","category":"himawari.vault-code"},
         "himawari":{"v":1,"tag":"vault-code-vc_AAAAAAAAAAAAAAAAAAAAAA","kind":"vault_code","navigate":"/","vaultCodeRequestId":"vc_AAAAAAAAAAAAAAAAAAAAAA","actions":[]}}
        """
        let userInfo = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [AnyHashable: Any])
        let push = try #require(HimawariPush(userInfo: userInfo))
        #expect(push.kind == HimawariPush.vaultCodeKind)
        #expect(push.vaultCodeRequestId == "vc_AAAAAAAAAAAAAAAAAAAAAA")
        #expect(push.vaultRequestId == nil)
    }

    @Test func readsTheApprovalRequestTheServerPushes() throws {
        let userInfo: [AnyHashable: Any] = ["himawari": ["v": 1, "kind": "vault_approval", "vaultRequestId": "vr_AAAAAAAAAAAAAAAAAAAAAA", "actions": []]]
        let push = try #require(HimawariPush(userInfo: userInfo))
        #expect(push.kind == HimawariPush.vaultApprovalKind)
        #expect(push.vaultRequestId == "vr_AAAAAAAAAAAAAAAAAAAAAA")
    }

    @Test func cleansWhatTheOwnerTypedTheWayTheServerAccepts() {
        #expect(VaultCode.cleaned(" 482 910 ") == "482910")
        #expect(VaultCode.cleaned("48-29-10") == "482910")
        #expect(VaultCode.cleaned("AB12cd") == "AB12cd")
        #expect(VaultCode.cleaned("123") == nil)
        #expect(VaultCode.cleaned("1234567890123") == nil)
        #expect(VaultCode.cleaned("12<34>") == nil)
        #expect(VaultCode.cleaned("１２３４５６") == nil)
    }
}
