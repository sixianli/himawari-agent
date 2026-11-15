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
        var shown: [String] = []
        menu.removeNotice = { removed.append($0) }
        menu.showNotice = { shown.append($0.id) }
        menu.receive(.notificationDeliver(notice("n-1")))
        menu.dismiss(notice("n-1"))
        menu.receive(.notificationDeliver(notice("n-1")))
        #expect(removed == ["n-1"])
        #expect(shown == ["n-1"])
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

    @Test func onlyTheNewestNoticeIsShownAndTheCountIsTheOtherUndismissedOnes() {
        let menu = model()
        for (id, time) in [("n-1", "2026-11-15T01:00:00.000Z"), ("n-2", "2026-11-15T02:00:00.000Z"), ("n-3", "2026-11-15T03:00:00.000Z")] {
            menu.receive(.notificationDeliver(DeviceNotification(id: id, kind: "run_result", title: id, body: "", homeKey: nil, createdAt: time)))
        }
        #expect(menu.latestNotice?.id == "n-3")
        #expect(menu.olderNotices.map(\.id) == ["n-2", "n-1"])
        menu.dismiss(DeviceNotification(id: "n-2", kind: "run_result", title: "n-2", body: "", homeKey: nil, createdAt: "2026-11-15T02:00:00.000Z"))
        #expect(menu.olderNotices.map(\.id) == ["n-1"])
    }

    @Test func theOlderListFoldsBackWhenNothingOlderIsLeft() {
        let menu = model()
        menu.receive(.notificationDeliver(DeviceNotification(id: "n-1", kind: "run_result", title: "a", body: "", homeKey: nil, createdAt: "2026-11-15T01:00:00.000Z")))
        menu.receive(.notificationDeliver(DeviceNotification(id: "n-2", kind: "run_result", title: "b", body: "", homeKey: nil, createdAt: "2026-11-15T02:00:00.000Z")))
        menu.toggleOlderNotices()
        #expect(menu.noticesExpanded)
        menu.receive(.notificationWithdraw(id: "n-1"))
        #expect(menu.olderNotices.isEmpty)
        #expect(!menu.noticesExpanded)
    }

    @Test func openingAnOlderNoticeUnfoldsTheListButTheNewestOneLeavesItFolded() {
        let menu = model()
        menu.receive(.notificationDeliver(DeviceNotification(id: "n-1", kind: "run_result", title: "a", body: "", homeKey: nil, createdAt: "2026-11-15T01:00:00.000Z")))
        menu.receive(.notificationDeliver(DeviceNotification(id: "n-2", kind: "run_result", title: "b", body: "", homeKey: nil, createdAt: "2026-11-15T02:00:00.000Z")))
        menu.reveal("n-2")
        #expect(!menu.noticesExpanded)
        menu.reveal("gone")
        #expect(!menu.noticesExpanded)
        #expect(menu.revealedNotice == nil)
        menu.reveal("n-1")
        #expect(menu.noticesExpanded)
        #expect(menu.olderNotices.map(\.id) == ["n-1"])
        #expect(menu.revealedNotice == NoticeReveal(id: "n-1", serial: 1))
    }

    @Test func theOpenedOlderNoticeIsTheOneTheListScrollsTo() {
        let menu = model()
        for (index, id) in ["n-1", "n-2", "n-3", "n-4", "n-5"].enumerated() {
            menu.receive(.notificationDeliver(DeviceNotification(id: id, kind: "run_result", title: id, body: "", homeKey: nil, createdAt: "2026-11-15T0\(index):00:00.000Z")))
        }
        menu.reveal("n-1")
        #expect(menu.revealedNotice?.id == "n-1")
        menu.reveal("n-1")
        #expect(menu.revealedNotice == NoticeReveal(id: "n-1", serial: 2))
        menu.reveal("n-3")
        #expect(menu.revealedNotice?.id == "n-3")
        menu.receive(.notificationWithdraw(id: "n-1"))
        #expect(menu.revealedNotice?.id == "n-3")
        if let notice = menu.olderNotices.first(where: { $0.id == "n-3" }) { menu.dismiss(notice) }
        #expect(menu.revealedNotice == nil)
        menu.reveal("n-2")
        menu.toggleOlderNotices()
        #expect(menu.revealedNotice == nil)
    }

    private func withTemporaryStores(_ count: Int, _ body: ([FileLocalStore]) throws -> Void) throws {
        let directories = (0 ..< count).map { _ in FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true) }
        defer { for directory in directories { try? FileManager.default.removeItem(at: directory) } }
        try body(directories.map { try FileLocalStore(directory: $0) })
    }

    private func settledIds(in store: FileLocalStore) -> [String] {
        store.read(PendingNotifications.settledName).flatMap { try? JSONDecoder().decode([String].self, from: $0) } ?? []
    }

    private func deliverOldNotices(to menu: MenuBarModel) {
        menu.receive(.notificationDeliver(DeviceNotification(id: "old-1", kind: "run_result", title: "a", body: "", homeKey: nil, createdAt: "2026-11-15T01:00:00.000Z")))
        menu.receive(.notificationDeliver(DeviceNotification(id: "old-2", kind: "run_result", title: "b", body: "", homeKey: nil, createdAt: "2026-11-15T02:00:00.000Z")))
        menu.receive(.notificationWithdraw(id: "old-settled"))
        menu.reveal("old-1")
    }

    @Test func noticesSettledBeforeTheFirstStoreAreSavedInIt() throws {
        try withTemporaryStores(1) { stores in
            let menu = model()
            menu.receive(.notificationWithdraw(id: "before-ready"))
            menu.app.useDemoDeviceStore(stores[0])
            #expect(settledIds(in: stores[0]) == ["before-ready"])
        }
    }

    @Test func aStoreTheAppAlreadyHasIsUsedFromTheStart() throws {
        try withTemporaryStores(1) { stores in
            let app = AppModel.demo(.active, host: "himawari.example.com", kind: .mac)
            app.useDemoDeviceStore(stores[0])
            let menu = MenuBarModel(demo: app, settings: MacSettingsStore(demo: MacAccessSettings()), home: nil, running: [], shortcut: nil)
            menu.receive(.notificationWithdraw(id: "n-1"))
            #expect(settledIds(in: stores[0]) == ["n-1"])
        }
    }

    @Test func pairingAgainClearsTheOldNoticesTheMomentTheDeviceStoreChanges() throws {
        try withTemporaryStores(2) { stores in
            let (old, fresh) = (stores[0], stores[1])
            let menu = model()
            var removed: [String] = []
            var shown: [String] = []
            menu.removeNotice = { removed.append($0) }
            menu.showNotice = { shown.append($0.id) }
            menu.app.useDemoDeviceStore(old)
            deliverOldNotices(to: menu)
            removed = []
            menu.app.useDemoDeviceStore(fresh)
            #expect(menu.shownNotices.isEmpty)
            #expect(Set(removed) == ["old-1", "old-2"])
            #expect(menu.revealedNotice == nil)
            #expect(!menu.noticesExpanded)
            #expect(settledIds(in: fresh).isEmpty)
            menu.receive(.notificationDeliver(DeviceNotification(id: "old-settled", kind: "run_result", title: "c", body: "", homeKey: nil, createdAt: "2026-11-15T03:00:00.000Z")))
            #expect(shown.last == "old-settled")
            #expect(settledIds(in: old) == ["old-settled"])
        }
    }

    @Test func forgettingTheDeviceClearsTheOldNoticesEvenWithoutPairingAgain() throws {
        try withTemporaryStores(1) { stores in
            let menu = model()
            var removed: [String] = []
            menu.removeNotice = { removed.append($0) }
            menu.app.useDemoDeviceStore(stores[0])
            deliverOldNotices(to: menu)
            removed = []
            menu.app.useDemoDeviceStore(nil)
            #expect(menu.shownNotices.isEmpty)
            #expect(Set(removed) == ["old-1", "old-2"])
            #expect(menu.revealedNotice == nil)
            #expect(!menu.noticesExpanded)
        }
    }

    @Test func dismissingACardFromTheOldDeviceDoesNotWriteItIntoTheNewStore() throws {
        try withTemporaryStores(2) { stores in
            let menu = model()
            var removed: [String] = []
            menu.removeNotice = { removed.append($0) }
            menu.app.useDemoDeviceStore(stores[0])
            deliverOldNotices(to: menu)
            let stale = try #require(menu.latestNotice)
            menu.app.useDemoDeviceStore(stores[1])
            removed = []
            menu.dismiss(stale)
            #expect(settledIds(in: stores[1]).isEmpty)
            #expect(removed.isEmpty)
        }
    }

    @Test func theSystemIdleTimeCanBeRead() throws {
        let seconds = try #require(PresenceSensor.secondsSinceInput())
        #expect(seconds >= 0)
    }
}
#endif
