#if os(macOS)
import Foundation
import HimawariCore
@testable import HimawariMacUI
import HimawariShell
import Testing

@MainActor
@Suite struct NoticeAndPresenceTests {
    private func model(home: HomeSnapshot? = nil) -> MenuBarModel {
        MenuBarModel(
            demo: AppModel.demo(.active, host: "himawari.example.com", kind: .mac),
            settings: MacSettingsStore(demo: MacAccessSettings()),
            home: home,
            running: [],
            shortcut: nil
        )
    }

    private func notice(_ id: String, homeKey: String? = nil) -> DeviceNotification {
        DeviceNotification(id: id, kind: "reminder", title: "该出门了", body: "", homeKey: homeKey, createdAt: "2026-11-15T05:35:00.000Z")
    }

    @Test func aDeliveredNoticeIsShownOnceAndAppearsInThePanel() {
        let menu = model()
        var shown: [String] = []
        menu.showNotice = { shown.append($0.id) }
        menu.receive(.notificationDeliver(notice("n-1")))
        menu.receive(.notificationDeliver(notice("n-1")))
        #expect(shown == ["n-1"])
        #expect(menu.shownNotices.map(\.id) == ["n-1"])
    }

    @Test func withdrawRemovesTheSystemNoticeAndThePanelRowEvenForANoticeThisRunNeverSaw() {
        let menu = model()
        var removed: [String] = []
        menu.removeNotice = { removed.append($0) }
        menu.receive(.notificationDeliver(notice("n-1")))
        menu.receive(.notificationWithdraw(id: "n-1"))
        menu.receive(.notificationWithdraw(id: "from-before-restart"))
        #expect(removed == ["n-1", "from-before-restart"])
        #expect(menu.shownNotices.isEmpty)
    }

    @Test func dismissingLocallyRemovesTheRowAndTheSystemNotice() {
        let menu = model()
        var removed: [String] = []
        menu.removeNotice = { removed.append($0) }
        menu.receive(.notificationDeliver(notice("n-1")))
        menu.dismiss(notice("n-1"))
        #expect(removed == ["n-1"])
        #expect(menu.shownNotices.isEmpty)
    }

    @Test func aNoticeForTheItemAlreadyShownAsMostPressingIsNotRepeated() throws {
        let menu = model(home: MacDemo.home())
        let pressing = try #require(menu.mostPressing?.key)
        menu.receive(.notificationDeliver(notice("n-1", homeKey: pressing)))
        menu.receive(.notificationDeliver(notice("n-2", homeKey: "other")))
        #expect(menu.shownNotices.map(\.id) == ["n-2"])
    }

    @Test func otherStreamEventsDoNothing() {
        let menu = model()
        var shown = 0
        menu.showNotice = { _ in shown += 1 }
        menu.receive(.connected)
        #expect(shown == 0)
        #expect(menu.shownNotices.isEmpty)
    }

    @Test func theSystemIdleTimeCanBeRead() throws {
        let seconds = try #require(PresenceSensor.secondsSinceInput())
        #expect(seconds >= 0)
    }
}
#endif
