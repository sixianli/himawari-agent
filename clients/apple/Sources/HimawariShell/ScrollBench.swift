#if DEBUG && os(iOS)
import HimawariChat
import HimawariCore
import SwiftUI
import UIKit

enum ScrollBench {
    static let argument = "-HimawariScrollBench"
    static let resultFile = "himawari-scroll-bench.json"
    static let speed: CGFloat = 2400
    static let settleSeconds = 3.0

    static var requested: DemoChatFixtures.ScrollLoad? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: argument), arguments.indices.contains(index + 1) else { return nil }
        return DemoChatFixtures.ScrollLoad(rawValue: arguments[index + 1])
    }
}

struct ScrollBenchView: View {
    let load: DemoChatFixtures.ScrollLoad
    @State private var store: ChatStore

    init(load: DemoChatFixtures.ScrollLoad) {
        self.load = load
        _store = State(initialValue: .demo(DemoChatFixtures.scrollLoad(load)))
    }

    var body: some View {
        ChatView(store: store, threadId: DemoChatFixtures.osakaThreadId)
            .environment(\.listClock, DemoChatFixtures.now)
            .task {
                try? await Task.sleep(for: .seconds(ScrollBench.settleSeconds))
                let report = await ScrollDriver(speed: ScrollBench.speed).run()
                let file = FileManager.default.temporaryDirectory.appendingPathComponent(ScrollBench.resultFile)
                let data = (try? JSONSerialization.data(withJSONObject: report.json(load: load.rawValue), options: [.sortedKeys])) ?? Data()
                try? data.write(to: file, options: .atomic)
            }
    }
}

struct FrameLog {
    var frames = 0
    var seconds: Double = 0
    var hitches = 0
    var hitchSeconds: Double = 0
    var worst: Double = 0
    var durations: [Double] = []

    mutating func add(_ delta: Double, expected: Double) {
        frames += 1
        seconds += delta
        durations.append(delta)
        worst = max(worst, delta)
        if delta > expected * 1.5 {
            hitches += 1
            hitchSeconds += delta - expected
        }
    }

    var json: [String: Any] {
        let sorted = durations.sorted()
        let p95 = sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
        return [
            "frames": frames,
            "seconds": (seconds * 1000).rounded() / 1000,
            "hitches": hitches,
            "hitchMs": (hitchSeconds * 1000).rounded(),
            "hitchRatioMsPerS": seconds > 0 ? ((hitchSeconds * 1000 / seconds) * 10).rounded() / 10 : 0,
            "worstFrameMs": (worst * 1000 * 10).rounded() / 10,
            "p95FrameMs": (p95 * 1000 * 10).rounded() / 10,
        ]
    }
}

struct ScrollReport {
    var up = FrameLog()
    var down = FrameLog()
    var reachedTop = false
    var reachedBottom = false
    var contentHeight: CGFloat = 0
    var problem: String?

    func json(load: String) -> [String: Any] {
        var all = FrameLog()
        for log in [up, down] {
            all.frames += log.frames
            all.seconds += log.seconds
            all.hitches += log.hitches
            all.hitchSeconds += log.hitchSeconds
            all.worst = max(all.worst, log.worst)
            all.durations += log.durations
        }
        var object: [String: Any] = [
            "load": load,
            "up": up.json,
            "down": down.json,
            "all": all.json,
            "reachedTop": reachedTop,
            "reachedBottom": reachedBottom,
            "contentHeight": Int(contentHeight),
        ]
        if let problem { object["problem"] = problem }
        return object
    }
}

@MainActor
final class ScrollDriver: NSObject {
    private let speed: CGFloat
    private var link: CADisplayLink?
    private weak var scrollView: UIScrollView?
    private var last: CFTimeInterval?
    private var goingUp = true
    private var report = ScrollReport()
    private var finish: CheckedContinuation<ScrollReport, Never>?
    private var started: CFTimeInterval = 0
    private static let limitSeconds: CFTimeInterval = 60

    init(speed: CGFloat) {
        self.speed = speed
    }

    func run() async -> ScrollReport {
        guard let scrollView = Self.transcriptScrollView() else {
            report.problem = "no scroll view"
            return report
        }
        self.scrollView = scrollView
        return await withCheckedContinuation { continuation in
            finish = continuation
            started = CACurrentMediaTime()
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard let scrollView else { return stop(problem: "scroll view went away") }
        let now = link.timestamp
        let expected = link.targetTimestamp - link.timestamp
        defer { last = now }
        guard let last else { return }
        let delta = now - last
        if goingUp { report.up.add(delta, expected: expected) } else { report.down.add(delta, expected: expected) }
        let top = -scrollView.adjustedContentInset.top
        let bottom = max(top, scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
        let step = speed * CGFloat(delta)
        var offset = scrollView.contentOffset
        if goingUp {
            offset.y = max(top, offset.y - step)
            if offset.y <= top {
                report.reachedTop = true
                goingUp = false
            }
        } else {
            offset.y = min(bottom, offset.y + step)
            if offset.y >= bottom {
                report.reachedBottom = true
                scrollView.setContentOffset(offset, animated: false)
                return stop(problem: nil)
            }
        }
        scrollView.setContentOffset(offset, animated: false)
        if now - started > Self.limitSeconds { stop(problem: "did not finish in \(Int(Self.limitSeconds)) s") }
    }

    private func stop(problem: String?) {
        link?.invalidate()
        link = nil
        report.problem = problem
        report.contentHeight = scrollView?.contentSize.height ?? 0
        finish?.resume(returning: report)
        finish = nil
    }

    private static func transcriptScrollView() -> UIScrollView? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        var best: UIScrollView?
        for window in windows {
            for view in descendants(of: window) {
                guard let scroll = view as? UIScrollView, !(scroll is UITextView) else { continue }
                if scroll.contentSize.height > (best?.contentSize.height ?? 0) { best = scroll }
            }
        }
        return best
    }

    private static func descendants(of view: UIView) -> [UIView] {
        view.subviews + view.subviews.flatMap(descendants)
    }
}
#endif
