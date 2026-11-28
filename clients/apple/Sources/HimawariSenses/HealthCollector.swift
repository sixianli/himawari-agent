#if os(iOS)
import CoreMotion
import Foundation
import HealthKit
import HimawariCore
import UIKit

@MainActor
public final class HealthCollector: SenseCollector {
    public let item = SenseItem.health
    static let anchorName = "health-since"
    static let motionName = "motion-since"
    static let sleepAnchorName = "health-sleep-anchor"
    static let workoutAnchorName = "health-workout-anchor"
    static let sampleTypes: [HKSampleType] = [HKQuantityType(.stepCount), HKQuantityType(.heartRate), HKCategoryType(.sleepAnalysis), HKObjectType.workoutType()]
    static let backfill: TimeInterval = 7 * 86_400

    private let store = HKHealthStore()
    private let motion = CMMotionActivityManager()
    private var sink: SenseSink?
    private var failure: Error?
    private var unlocked: NSObjectProtocol?
    private var retry: Task<Void, Never>?

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
        let firstDay = Date().addingTimeInterval(-Self.backfill)
        if sink.localStore.read(Self.anchorName) == nil { save(firstDay, Self.anchorName) }
        if sink.localStore.read(Self.motionName) == nil { save(firstDay, Self.motionName) }
        HealthWake.shared.attach(self)
        unlocked = NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.collect() }
        }
        Task { await collect() }
    }

    public func stop() {
        if let unlocked { NotificationCenter.default.removeObserver(unlocked) }
        unlocked = nil
        retry?.cancel()
        retry = nil
        HealthWake.shared.detach()
        motion.stopActivityUpdates()
        if let sink {
            try? sink.localStore.write(Self.anchorName, nil)
            try? sink.localStore.write(Self.motionName, nil)
            try? sink.localStore.write(Self.sleepAnchorName, nil)
            try? sink.localStore.write(Self.workoutAnchorName, nil)
        }
        sink = nil
    }

    func collect() async {
        guard let sink, let anchor = load(Self.anchorName) else { return }
        let calendar = Calendar.current
        let now = Date()
        guard let lastFullHour = calendar.dateInterval(of: .hour, for: now)?.start else {
            await collectMotion()
            return
        }
        let since = HealthReadWindow.start(anchor: anchor, lastFullHour: lastFullHour)
        let start = calendar.dateInterval(of: .hour, for: since)?.start ?? since
        retry?.cancel()
        retry = nil
        failure = nil
        let steps = await hourly(.stepCount, unit: .count(), options: .cumulativeSum, from: start, to: lastFullHour, kind: .steps, unitName: "count")
        let heart = await hourly(.heartRate, unit: HKUnit.count().unitDivided(by: .minute()), options: .discreteAverage, from: start, to: lastFullHour, kind: .heartRate, unitName: "count/min")
        let others = await samples(recentFrom: now.addingTimeInterval(-Self.backfill))
        if steps, heart, others, self.sink === sink {
            save(lastFullHour, Self.anchorName)
            await sink.readProblems.succeeded(.health)
        } else if let failure, self.sink === sink {
            await failed(failure, sink: sink)
        }
        await collectMotion()
    }

    private func failed(_ error: Error, sink: SenseSink) async {
        let code = (error as? HKError)?.code
        if code == .errorDatabaseInaccessible { return }
        if code == .errorAuthorizationDenied || code == .errorAuthorizationNotDetermined { return }
        let failures = await sink.readProblems.failed(.health, code: "HEALTH_\((error as NSError).code)")
        let delay = ReadRetry.delay(afterFailures: failures)
        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.collect()
        }
    }

    private func hourly(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, options: HKStatisticsOptions, from start: Date, to end: Date, kind: SenseObservations.HealthKind, unitName: String) async -> Bool {
        let type = HKQuantityType(identifier)
        let predicate = HKSamplePredicate.quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end))
        let descriptor = HKStatisticsCollectionQueryDescriptor(predicate: predicate, options: options, anchorDate: start, intervalComponents: DateComponents(hour: 1))
        let collection: HKStatisticsCollection
        do {
            collection = try await descriptor.result(for: store)
        } catch {
            failure = error
            return false
        }
        var found: [(SenseObservation, String)] = []
        for statistics in collection.statistics() where statistics.startDate >= start && statistics.endDate <= end {
            let quantity = options.contains(.cumulativeSum) ? statistics.sumQuantity() : statistics.averageQuantity()
            guard let quantity else { continue }
            let value = quantity.doubleValue(for: unit)
            guard value > 0 else { continue }
            let observation = SenseObservations.health(kind, value: value.rounded(), unit: unitName, start: statistics.startDate, end: statistics.endDate)
            found.append((observation, SenseRecordBuilder.stableId(["health", kind.rawValue, String(statistics.startDate.timeIntervalSince1970)])))
        }
        return await keep(found)
    }

    private func samples(recentFrom start: Date) async -> Bool {
        let window = HKQuery.predicateForSamples(withStart: start, end: nil)
        let sleep = HKAnchoredObjectQueryDescriptor(predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: window)], anchor: anchor(Self.sleepAnchorName))
        let sleeps: HKAnchoredObjectQueryDescriptor<HKCategorySample>.Result
        do {
            sleeps = try await sleep.result(for: store)
        } catch {
            failure = error
            return false
        }
        var kept: [(SenseObservation, String)] = []
        for sample in sleeps.addedSamples {
            guard HKCategoryValueSleepAnalysis.allAsleepValues.map(\.rawValue).contains(sample.value) else { continue }
            let minutes = sample.endDate.timeIntervalSince(sample.startDate) / 60
            let observation = SenseObservations.health(.sleep, value: minutes.rounded(), unit: "min", start: sample.startDate, end: sample.endDate)
            kept.append((observation, SenseRecordBuilder.stableId(["health", "sleep", sample.uuid.uuidString])))
        }
        guard await keep(kept) else { return false }
        save(sleeps.newAnchor, Self.sleepAnchorName)
        kept = []
        let workouts = HKAnchoredObjectQueryDescriptor(predicates: [.workout(window)], anchor: anchor(Self.workoutAnchorName))
        let found: HKAnchoredObjectQueryDescriptor<HKWorkout>.Result
        do {
            found = try await workouts.result(for: store)
        } catch {
            failure = error
            return false
        }
        for workout in found.addedSamples {
            let minutes = workout.duration / 60
            let observation = SenseObservations.health(.workout, value: minutes.rounded(), unit: "min", start: workout.startDate, end: workout.endDate, workoutType: Self.name(workout.workoutActivityType))
            kept.append((observation, SenseRecordBuilder.stableId(["health", "workout", workout.uuid.uuidString])))
        }
        guard await keep(kept) else { return false }
        save(found.newAnchor, Self.workoutAnchorName)
        return true
    }

    private func anchor(_ name: String) -> HKQueryAnchor? {
        sink?.localStore.read(name).flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
    }

    private func save(_ anchor: HKQueryAnchor, _ name: String) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        try? sink?.localStore.write(name, data)
    }

    private func keep(_ found: [(SenseObservation, String)]) async -> Bool {
        guard let sink else { return false }
        var all = true
        for (observation, id) in found {
            let kept = await sink.keep(observation, id: id, captureSource: SenseRecordBuilder.sensorSource)
            if !kept { all = false }
        }
        return all
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

@MainActor
public final class HealthWake {
    public static let shared = HealthWake()
    static let enabledKey = "himawari.health.background-delivery"

    private let store = HKHealthStore()
    private var queries: [HKQuery] = []
    private weak var collector: HealthCollector?
    private var waiting: [Int: ObserverCompletion] = [:]
    private var next = 0

    public static func install() {
        guard UserDefaults.standard.bool(forKey: enabledKey) else { return }
        shared.register()
    }

    func attach(_ collector: HealthCollector) {
        UserDefaults.standard.set(true, forKey: Self.enabledKey)
        self.collector = collector
        register()
        let pending = Array(waiting.values)
        waiting.removeAll()
        guard !pending.isEmpty else { return }
        Task {
            await collector.collect()
            pending.forEach { $0.call() }
        }
    }

    func detach() {
        UserDefaults.standard.set(false, forKey: Self.enabledKey)
        collector = nil
        queries.forEach(store.stop)
        queries.removeAll()
        store.disableAllBackgroundDelivery { _, _ in }
        let pending = Array(waiting.values)
        waiting.removeAll()
        pending.forEach { $0.call() }
    }

    private func register() {
        guard queries.isEmpty, HKHealthStore.isHealthDataAvailable() else { return }
        for type in HealthCollector.sampleTypes {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { @Sendable _, completion, _ in
                let finished = ObserverCompletion(completion)
                Task { @MainActor in await HealthWake.shared.changed(finished) }
            }
            store.execute(query)
            queries.append(query)
            store.enableBackgroundDelivery(for: type, frequency: .hourly) { _, _ in }
        }
    }

    private func changed(_ finished: ObserverCompletion) async {
        if let collector {
            await collector.collect()
            finished.call()
            return
        }
        next += 1
        let id = next
        waiting[id] = finished
        try? await Task.sleep(for: .seconds(25))
        waiting.removeValue(forKey: id)?.call()
    }
}

struct ObserverCompletion: @unchecked Sendable {
    let call: () -> Void

    init(_ call: @escaping () -> Void) {
        self.call = call
    }
}
#endif
