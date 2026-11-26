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

    @Test func aDeliveredNoticeIsShownOnceAndIsKeptAsPending() {
        let menu = model()
        var shown: [String] = []
        menu.showNotice = { shown.append($0.id) }
        menu.receive(.notificationDeliver(notice("n-1")))
        menu.receive(.notificationDeliver(notice("n-1")))
        #expect(shown == ["n-1"])
        #expect(menu.shownNotices.map(\.id) == ["n-1"])
    }

    @Test func withdrawRemovesTheSystemNoticeEvenForANoticeThisRunNeverSaw() {
        let menu = model()
        var removed: [String] = []
        menu.removeNotice = { removed.append($0) }
        menu.receive(.notificationDeliver(notice("n-1")))
        menu.receive(.notificationWithdraw(id: "n-1"))
        menu.receive(.notificationWithdraw(id: "from-before-restart"))
        #expect(removed == ["n-1", "from-before-restart"])
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
        }
    }

    @Test func theSystemIdleTimeCanBeRead() throws {
        let seconds = try #require(PresenceSensor.secondsSinceInput())
        #expect(seconds >= 0)
    }
}
#endif
