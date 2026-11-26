#if os(macOS)
import AppKit
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
        main.go(to: .her(.memory))
        #expect(main.selection == .chat)
        await main.syncWithSignIn()
        #expect(main.workspace == nil)
        #expect(main.settingsSections.isEmpty)
    }

    @Test func talkingFromAPagePutsTheTextIntoANewChatDraft() {
        let main = MacMainModel(app: AppModel.demo(.active, host: "himawari.example.com", kind: .mac))
        main.selection = .her(.memory)
        let before = main.draft.id
        main.talk("把这条记忆改一下")
        #expect(main.selection == .chat)
        #expect(main.draft.text == "把这条记忆改一下")
        #expect(main.draft.id != before)
    }

    @Test func onlyApprovalsCarryABadge() {
        let main = MacMainModel(app: AppModel.demo(.active, host: "himawari.example.com", kind: .mac))
        #expect(main.badge(for: .chat) == 0)
        #expect(main.badge(for: .her(.memory)) == 0)
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
}
#endif
