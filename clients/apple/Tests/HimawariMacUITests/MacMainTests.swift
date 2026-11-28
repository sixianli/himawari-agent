#if os(macOS)
import AppKit
import Foundation
import HimawariCore
@testable import HimawariMacUI
import HimawariShell
import Testing

@MainActor
@Suite struct MacMainTests {
    @Test func withoutASignedInChatThereIsNothingToGoTo() async {
        let main = MacMainModel(app: AppModel.demo(.active, host: "himawari.example.com", kind: .mac))
        #expect(!main.isSignedIn)
        #expect(main.destinations.isEmpty)
        main.go(to: .her(.personalization))
        #expect(main.selection == .chat)
        await main.syncWithSignIn()
        #expect(main.workspace == nil)
        #expect(main.settingsSections.isEmpty)
    }

    @Test func talkingFromAPagePutsTheTextIntoANewChatDraft() {
        let main = MacMainModel(app: AppModel.demo(.active, host: "himawari.example.com", kind: .mac))
        main.selection = .her(.personalization)
        let before = main.draft.id
        main.talk("把这条记忆改一下")
        #expect(main.selection == .chat)
        #expect(main.draft.text == "把这条记忆改一下")
        #expect(main.draft.id != before)
    }

    @Test func onlyApprovalsCarryABadge() {
        let main = MacMainModel(app: AppModel.demo(.active, host: "himawari.example.com", kind: .mac))
        #expect(main.badge(for: .chat) == 0)
        #expect(main.badge(for: .her(.personalization)) == 0)
        #expect(main.badge(for: .her(.approvals)) == 0)
    }

    @Test func theMenuShowsTheGlobalShortcutOnTalk() {
        let item = NSMenuItem()
        MenuBarController.apply(.optionSpace, to: item)
        #expect(item.keyEquivalent == " ")
        #expect(item.keyEquivalentModifierMask == [.option])

        let letter = NSMenuItem()
        MenuBarController.apply(KeyShortcut(keyCode: 4, modifiers: KeyShortcut.commandModifier | KeyShortcut.shiftModifier, key: "H"), to: letter)
        #expect(letter.keyEquivalent == "h")
        #expect(letter.keyEquivalentModifierMask == [.command, .shift])
    }

    @Test func updatesTurnOnOnlyWithAnHTTPSFeedAndAFullPublicKey() {
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        #expect(MacUpdater.isConfigured(feed: "https://github.com/o/r/releases/download/mac-updates/appcast.xml", publicKey: key))
        #expect(!MacUpdater.isConfigured(feed: "", publicKey: ""))
        #expect(!MacUpdater.isConfigured(feed: nil, publicKey: key))
        #expect(!MacUpdater.isConfigured(feed: "http://example.com/appcast.xml", publicKey: key))
        #expect(!MacUpdater.isConfigured(feed: "https://example.com/appcast.xml", publicKey: Data(repeating: 7, count: 16).base64EncodedString()))
        #expect(!MacUpdater.isConfigured(feed: "https://example.com/appcast.xml", publicKey: "$(HIMAWARI_UPDATE_KEY)"))
    }
}
#endif
