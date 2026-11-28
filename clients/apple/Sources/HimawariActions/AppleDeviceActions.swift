import Foundation
import HimawariCore
#if canImport(EventKit)
import EventKit
#endif

public enum AppleDeviceActions {
    @MainActor
    public static func handlers() -> [DeviceActionHandler] {
        var handlers: [DeviceActionHandler] = []
        #if canImport(EventKit)
        let events = EKEventStore()
        handlers.append(CalendarActions(store: events))
        handlers.append(ReminderActions(store: events))
        #endif
        #if canImport(Contacts)
        handlers.append(ContactActions())
        #endif
        #if canImport(AlarmKit)
        handlers.append(AlarmActions())
        #endif
        #if os(iOS) && canImport(HomeKit)
        handlers.append(HomeActions())
        #endif
        #if os(iOS) && canImport(CoreLocation)
        handlers.append(LocationActions())
        #endif
        #if os(iOS)
        handlers.append(DeviceStatusActions())
        #endif
        return handlers
    }
}
