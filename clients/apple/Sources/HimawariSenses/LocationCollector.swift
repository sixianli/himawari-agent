#if os(iOS)
import CoreLocation
import Foundation
import HimawariCore

@MainActor
public final class LocationCollector: NSObject, AlwaysCollecting, @preconcurrency CLLocationManagerDelegate {
    public let item = SenseItem.location
    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var sink: SenseSink?
    private var waiting: [CheckedContinuation<SenseAuthorization, Never>] = []

    override public init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.pausesLocationUpdatesAutomatically = true
        manager.activityType = .other
    }

    public var alwaysAllowed: Bool { manager.authorizationStatus == .authorizedAlways }

    public func authorization() async -> SenseAuthorization {
        Self.map(manager.authorizationStatus)
    }

    public func requestAuthorization() async -> SenseAuthorization {
        guard manager.authorizationStatus == .notDetermined else { return Self.map(manager.authorizationStatus) }
        return await withCheckedContinuation { continuation in
            waiting.append(continuation)
            manager.requestWhenInUseAuthorization()
        }
    }

    public func requestAlways() async -> Bool {
        guard manager.authorizationStatus == .authorizedWhenInUse else { return alwaysAllowed }
        _ = await withCheckedContinuation { continuation in
            waiting.append(continuation)
            manager.requestAlwaysAuthorization()
        }
        if alwaysAllowed, sink != nil { applyBackground() }
        return alwaysAllowed
    }

    public func start(_ sink: SenseSink) {
        self.sink = sink
        manager.startMonitoringVisits()
        manager.startMonitoringSignificantLocationChanges()
        applyBackground()
    }

    public func stop() {
        manager.stopMonitoringVisits()
        manager.stopMonitoringSignificantLocationChanges()
        manager.allowsBackgroundLocationUpdates = false
        sink = nil
    }

    private func applyBackground() {
        manager.allowsBackgroundLocationUpdates = alwaysAllowed
        manager.showsBackgroundLocationIndicator = false
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager.authorizationStatus != .notDetermined else { return }
        let result = Self.map(manager.authorizationStatus)
        let pending = waiting
        waiting.removeAll()
        pending.forEach { $0.resume(returning: result) }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let sink else { return }
        for location in locations where location.horizontalAccuracy >= 0 {
            sink.point(TrackPointUpload(
                at: location.timestamp,
                latitude: location.coordinate.latitude,
                longitude: location.coordinate.longitude,
                accuracyMeters: location.horizontalAccuracy,
                speedMetersPerSecond: location.speed
            ))
        }
    }

    public func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        guard sink != nil else { return }
        let arrived = visit.arrivalDate == .distantPast ? nil : visit.arrivalDate
        let departed = visit.departureDate == .distantFuture ? nil : visit.departureDate
        let location = CLLocation(latitude: visit.coordinate.latitude, longitude: visit.coordinate.longitude)
        Task {
            let placemark = try? await geocoder.reverseGeocodeLocation(location).first
            let name = placemark.flatMap { $0.name ?? $0.thoroughfare ?? $0.subLocality ?? $0.locality }
            let observation = SenseObservations.visit(
                latitude: visit.coordinate.latitude,
                longitude: visit.coordinate.longitude,
                accuracyMeters: visit.horizontalAccuracy,
                arrivedAt: arrived,
                departedAt: departed,
                placeName: name
            )
            let key = ["visit", String(visit.coordinate.latitude), String(visit.coordinate.longitude), arrived.map { String($0.timeIntervalSince1970) } ?? "", departed.map { String($0.timeIntervalSince1970) } ?? ""]
            self.sink?.record(observation, id: SenseRecordBuilder.stableId(key), captureSource: SenseRecordBuilder.sensorSource)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    static func map(_ status: CLAuthorizationStatus) -> SenseAuthorization {
        switch status {
        case .notDetermined: .notAsked
        case .restricted: .restricted
        case .denied: .denied
        case .authorizedAlways, .authorizedWhenInUse: .allowed
        @unknown default: .denied
        }
    }
}
#endif
