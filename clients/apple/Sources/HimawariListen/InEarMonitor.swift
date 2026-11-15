#if os(iOS)
import CoreMotion
import Foundation

final class InEarMonitor: @unchecked Sendable {
    private let manager = CMHeadphoneMotionManager()
    private let queue = OperationQueue()
    private let lock = NSLock()
    private var lastMotion: Date?
    private var running = false
    private let freshness: TimeInterval

    init(freshness: TimeInterval = 2) {
        self.freshness = freshness
        queue.maxConcurrentOperationCount = 1
    }

    var available: Bool {
        manager.isDeviceMotionAvailable
    }

    func start() {
        guard manager.isDeviceMotionAvailable, !lock.withLock({ running }) else { return }
        lock.withLock { running = true }
        manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, _ in
            guard motion != nil, let self else { return }
            lock.withLock { lastMotion = Date() }
        }
    }

    func stop() {
        manager.stopDeviceMotionUpdates()
        lock.withLock {
            running = false
            lastMotion = nil
        }
    }

    func inEar(at now: Date = Date()) -> Bool? {
        lock.withLock {
            guard running else { return nil }
            guard let lastMotion else { return false }
            return now.timeIntervalSince(lastMotion) <= freshness
        }
    }
}
#endif
