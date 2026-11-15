#if os(iOS)
import CoreMotion
import Foundation
import HealthKit
import HimawariCore

@MainActor
public final class HealthCollector: SenseCollector {
    public let item = SenseItem.health
    static let anchorName = "health-since"
    static let motionName = "motion-since"

    private let store = HKHealthStore()
    private let motion = CMMotionActivityManager()
    private var sink: SenseSink?
    private var queries: [HKQuery] = []

    public init() {}

    private var readTypes: Set<HKObjectType> {
        [
            HKQuantityType(.stepCount),
            HKQuantityType(.heartRate),
            HKCategoryType(.sleepAnalysis),
            HKObjectType.workoutType(),
        ]
    }

    public func authorization() async -> SenseAuthorization {
        guard HKHealthStore.isHealthDataAvailable() else { return .unavailable }
        let status = try? await store.statusForAuthorizationRequest(toShare: [], read: readTypes)
        switch status {
        case .unnecessary: return CMMotionActivityManager.authorizationStatus() == .denied ? .limited : .allowed
        default: return .notAsked
        }
    }

    public func requestAuthorization() async -> SenseAuthorization {
        guard HKHealthStore.isHealthDataAvailable() else { return .unavailable }
        try? await store.requestAuthorization(toShare: [], read: readTypes)
        if CMMotionActivityManager.isActivityAvailable(), CMMotionActivityManager.authorizationStatus() == .notDetermined {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                motion.queryActivityStarting(from: Date().addingTimeInterval(-60), to: Date(), to: .main) { @Sendable _, _ in
                    continuation.resume()
                }
            }
        }
        return await authorization()
    }

    public func start(_ sink: SenseSink) {
        self.sink = sink
        if sink.localStore.read(Self.anchorName) == nil { save(Date(), Self.anchorName) }
        if sink.localStore.read(Self.motionName) == nil { save(Date(), Self.motionName) }
        for type in [HKQuantityType(.stepCount), HKQuantityType(.heartRate), HKCategoryType(.sleepAnalysis), HKObjectType.workoutType()] as [HKSampleType] {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { @Sendable [weak self] _, completion, _ in
                let finished = ObserverCompletion(completion)
                Task { @MainActor in
                    await self?.collect()
                    finished.call()
                }
            }
            store.execute(query)
            queries.append(query)
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
        Task { await collect() }
    }

    public func stop() {
        queries.forEach(store.stop)
        queries.removeAll()
        store.disableAllBackgroundDelivery { _, _ in }
        motion.stopActivityUpdates()
        if let sink {
            try? sink.localStore.write(Self.anchorName, nil)
            try? sink.localStore.write(Self.motionName, nil)
        }
        sink = nil
    }

    func collect() async {
        guard let sink, let since = load(Self.anchorName) else { return }
        let calendar = Calendar.current
        let now = Date()
        guard let lastFullHour = calendar.dateInterval(of: .hour, for: now)?.start, lastFullHour > since else {
            await collectMotion()
            return
        }
        let start = calendar.dateInterval(of: .hour, for: since)?.start ?? since
        await hourly(.stepCount, unit: .count(), options: .cumulativeSum, from: start, to: lastFullHour, kind: .steps, unitName: "count")
        await hourly(.heartRate, unit: HKUnit.count().unitDivided(by: .minute()), options: .discreteAverage, from: start, to: lastFullHour, kind: .heartRate, unitName: "count/min")
        await samples(from: since, to: now)
        save(lastFullHour, Self.anchorName)
        await collectMotion()
        _ = sink
    }

    private func hourly(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, options: HKStatisticsOptions, from start: Date, to end: Date, kind: SenseObservations.HealthKind, unitName: String) async {
        let type = HKQuantityType(identifier)
        let predicate = HKSamplePredicate.quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end))
        let descriptor = HKStatisticsCollectionQueryDescriptor(predicate: predicate, options: options, anchorDate: start, intervalComponents: DateComponents(hour: 1))
        guard let collection = try? await descriptor.result(for: store) else { return }
        collection.enumerateStatistics(from: start, to: end) { statistics, _ in
            let quantity = options.contains(.cumulativeSum) ? statistics.sumQuantity() : statistics.averageQuantity()
            guard let quantity else { return }
            let value = quantity.doubleValue(for: unit)
            guard value > 0 else { return }
            let observation = SenseObservations.health(kind, value: value.rounded(), unit: unitName, start: statistics.startDate, end: statistics.endDate)
            let id = SenseRecordBuilder.stableId(["health", kind.rawValue, String(statistics.startDate.timeIntervalSince1970)])
            MainActor.assumeIsolated { self.sink?.record(observation, id: id, captureSource: SenseRecordBuilder.sensorSource) }
        }
    }

    private func samples(from start: Date, to end: Date) async {
        let window = HKQuery.predicateForSamples(withStart: start, end: end)
        let sleep = HKSampleQueryDescriptor(predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: window)], sortDescriptors: [SortDescriptor(\.startDate)])
        for sample in (try? await sleep.result(for: store)) ?? [] {
            guard HKCategoryValueSleepAnalysis.allAsleepValues.map(\.rawValue).contains(sample.value) else { continue }
            let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60
            let observation = SenseObservations.health(.sleep, value: minutes.rounded(), unit: "min", start: sample.startDate, end: sample.endDate)
            sink?.record(observation, id: SenseRecordBuilder.stableId(["health", "sleep", sample.uuid.uuidString]), captureSource: SenseRecordBuilder.sensorSource)
        }
        let workouts = HKSampleQueryDescriptor(predicates: [.workout(window)], sortDescriptors: [SortDescriptor(\.startDate)])
        for workout in (try? await workouts.result(for: store)) ?? [] {
            let minutes = workout.duration / 60
            let observation = SenseObservations.health(.workout, value: minutes.rounded(), unit: "min", start: workout.startDate, end: workout.endDate, workoutType: Self.name(workout.workoutActivityType))
            sink?.record(observation, id: SenseRecordBuilder.stableId(["health", "workout", workout.uuid.uuidString]), captureSource: SenseRecordBuilder.sensorSource)
        }
    }

    private func collectMotion() async {
        guard CMMotionActivityManager.isActivityAvailable(), CMMotionActivityManager.authorizationStatus() == .authorized, let since = load(Self.motionName) else { return }
        let now = Date()
        let samples: [MotionSample] = await withCheckedContinuation { continuation in
            motion.queryActivityStarting(from: since, to: now, to: .main) { @Sendable activities, _ in
                continuation.resume(returning: (activities ?? []).compactMap(MotionSample.init))
            }
        }
        var previous: SenseObservations.Activity?
        for sample in samples where sample.kind != previous {
            previous = sample.kind
            sink?.record(
                SenseObservations.motion(sample.kind, certainty: sample.certainty, at: sample.start),
                id: SenseRecordBuilder.stableId(["motion", sample.kind.rawValue, String(sample.start.timeIntervalSince1970)]),
                captureSource: SenseRecordBuilder.sensorSource
            )
        }
        save(now, Self.motionName)
    }

    nonisolated static func kind(_ activity: CMMotionActivity) -> SenseObservations.Activity? {
        if activity.automotive { return .driving }
        if activity.cycling { return .cycling }
        if activity.running { return .running }
        if activity.walking { return .walking }
        if activity.stationary { return .stationary }
        return nil
    }

    static func name(_ type: HKWorkoutActivityType) -> String {
        String(describing: type)
    }

    private func load(_ name: String) -> Date? {
        sink?.localStore.read(name).flatMap { String(data: $0, encoding: .utf8) }.flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
    }

    private func save(_ date: Date, _ name: String) {
        try? sink?.localStore.write(name, Data(String(date.timeIntervalSince1970).utf8))
    }
}

struct MotionSample: Sendable {
    let kind: SenseObservations.Activity
    let certainty: SenseObservations.Certainty
    let start: Date

    init?(_ activity: CMMotionActivity) {
        guard activity.confidence != .low, let kind = HealthCollector.kind(activity) else { return nil }
        self.kind = kind
        certainty = activity.confidence == .high ? .high : .medium
        start = activity.startDate
    }
}

struct ObserverCompletion: @unchecked Sendable {
    let call: () -> Void

    init(_ call: @escaping () -> Void) {
        self.call = call
    }
}
#endif
