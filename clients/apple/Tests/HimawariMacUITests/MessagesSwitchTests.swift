#if os(macOS)
import HimawariCore
@testable import HimawariMacUI
import Testing

@MainActor
@Suite struct MessagesSwitchTests {
    @Test func aReadThatStartedBeforeTheSwitchWasFlippedOffAndOnCannotSetTheStartingPlace() {
        let store = MacSettingsStore(demo: MacAccessSettings(seesMessages: true))
        let epoch = store.messagesEpoch
        store.setSeesMessages(false)
        store.setSeesMessages(true)
        #expect(!store.moveMessagesCursor(from: nil, to: 4800, epoch: epoch))
        #expect(store.settings.messagesAfterRow == nil)
        #expect(store.moveMessagesCursor(from: nil, to: 5000, epoch: store.messagesEpoch))
        #expect(store.settings.messagesAfterRow == 5000)
    }

    @Test func turningItOffForgetsThePlaceAndTheProblem() {
        let store = MacSettingsStore(demo: MacAccessSettings(seesMessages: true), messagesProblem: .cannotSend)
        store.moveMessagesCursor(from: nil, to: 4800, epoch: store.messagesEpoch)
        store.setSeesMessages(false)
        #expect(store.settings.messagesAfterRow == nil)
        #expect(store.messagesProblem == nil)
    }
}
#endif
