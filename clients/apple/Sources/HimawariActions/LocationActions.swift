#if os(iOS) && canImport(CoreLocation)
import CoreLocation
import Foundation
import HimawariCore
import UIKit

public struct LocationPermission: DevicePermission {
    public var id: String { "location" }
    public var name: LocalizedLine { line("位置", "Location", "位置情報") }
    public var settingsPath: LocalizedLine { SettingsPath.app }
    public var shownToOwner: Bool { false }
    public var purpose: LocalizedLine {
        line("你问“我现在在哪”“附近有什么”时，Himawari 用这台 iPhone 现场定一次位。",
             "When you ask where you are or what's nearby, Himawari locates this iPhone once.",
             "「今どこ」「近くに何がある」と聞くと、この iPhone で一度だけ測位します。")
    }

    public func status() async -> DevicePermissionStatus {
        await MainActor.run { Self.map(CLLocationManager().authorizationStatus) }
    }

    public func request() async -> DevicePermissionStatus {
        await status()
    }

    static func map(_ status: CLAuthorizationStatus) -> DevicePermissionStatus {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse: .authorized
        case .notDetermined: .notDetermined
        case .restricted: .unavailable
        default: .denied
        }
    }
}

@MainActor
final class OneShotLocator: NSObject, @preconcurrency CLLocationManagerDelegate {
    static let preciseKey = "CurrentLocation"
    static let limit: Duration = .seconds(20)

    private let manager = CLLocationManager()
    private var waiter: CheckedContinuation<CLLocation?, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    var precise: Bool { manager.accuracyAuthorization == .fullAccuracy }

    func locate() async -> CLLocation? {
        if !precise, UIApplication.shared.applicationState == .active {
            _ = try? await manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: Self.preciseKey)
        }
        return await withCheckedContinuation { continuation in
            waiter?.resume(returning: nil)
            waiter = continuation
            manager.requestLocation()
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.limit)
                self?.answer(nil)
            }
        }
    }

    private func answer(_ location: CLLocation?) {
        waiter?.resume(returning: location)
        waiter = nil
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        answer(locations.last(where: { $0.horizontalAccuracy >= 0 }))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        answer(nil)
    }
}

public final class LocationActions: DeviceActionHandler, @unchecked Sendable {
    public let names = ["location.current"]
    public let readOnly: Set<String> = ["location.current"]
    public let permission: DevicePermission = LocationPermission()

    public init() {}

    public func snapshot(_ delivery: DeviceActionDelivery) async throws -> JSONObject? { [:] }

    public func perform(_ delivery: DeviceActionDelivery) async throws -> JSONObject {
        guard let fix = await OneShotLocator.fix() else { throw DeviceActionFailure(.system("LOCATION_UNAVAILABLE")) }
        var result: JSONObject = [
            "latitude": .number(fix.latitude),
            "longitude": .number(fix.longitude),
            "accuracyMeters": .number(fix.accuracyMeters.rounded()),
            "precise": .bool(fix.precise),
            "at": .string(ISO8601DateFormatter().string(from: fix.at)),
        ]
        if let address = fix.address { result["address"] = .string(address) }
        return result
    }

    static func address(_ placemark: CLPlacemark) -> String? {
        let parts = [placemark.name, placemark.thoroughfare, placemark.subLocality, placemark.locality, placemark.administrativeArea, placemark.country]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        var seen = Set<String>()
        let unique = parts.filter { seen.insert($0).inserted }
        return unique.isEmpty ? nil : unique.joined(separator: ", ")
    }

    public func readBack(_ delivery: DeviceActionDelivery, made: JSONObject?) async throws -> DeviceActionReading {
        .unreadable
    }
}

struct LocationFix: Sendable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
    let precise: Bool
    let at: Date
    let address: String?
}

extension OneShotLocator {
    static func fix() async -> LocationFix? {
        let locator = OneShotLocator()
        guard let location = await locator.locate() else { return nil }
        let placemark = try? await CLGeocoder().reverseGeocodeLocation(location).first
        return LocationFix(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracyMeters: location.horizontalAccuracy,
            precise: locator.precise,
            at: location.timestamp,
            address: placemark.flatMap(LocationActions.address)
        )
    }
}
#endif
