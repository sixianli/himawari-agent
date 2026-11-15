import Foundation
#if canImport(WatchKit)
import WatchKit
#endif

public enum WatchDeviceName {
    public static func current(fallback: String = "Apple Watch") -> String {
        #if canImport(WatchKit) && os(watchOS)
        PairingRequestLimits.deviceName(WKInterfaceDevice.current().name, fallback: fallback)
        #else
        fallback
        #endif
    }
}
