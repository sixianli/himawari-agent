import SwiftUI

public struct SunflowerMark: View {
    public enum Motion: Equatable, Sendable {
        case still
        case growing
        case breathing(low: Double)
        case growingOnce(from: Date)
    }

    private let motion: Motion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.stillFrames) private var stillFrames

    public init(growing: Bool = false) {
        motion = growing ? .growing : .still
    }

    public init(motion: Motion) {
        self.motion = motion
    }

    public var body: some View {
        if motion != .still && !reduceMotion && !stillFrames {
            TimelineView(.animation) { context in
                disc(startsEmpty: startsEmpty) { seeds in growth(at: context.date, seeds: seeds) }
            }
        } else {
            disc(startsEmpty: false) { seeds in SunflowerSeeds.resting(seeds: seeds) }
        }
    }

    private var startsEmpty: Bool {
        switch motion {
        case .breathing, .growingOnce: true
        case .still, .growing: false
        }
    }

    private func growth(at date: Date, seeds: Int) -> Double {
        switch motion {
        case .still:
            return SunflowerSeeds.resting(seeds: seeds)
        case .growing:
            let seconds = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10_000)
            return SunflowerSeeds.resting(seeds: seeds) + seconds * SunflowerSeeds.growthPerSecond(seeds: seeds)
        case let .breathing(low):
            return SunflowerSeeds.breathing(seconds: date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10_000), seeds: seeds, low: low)
        case let .growingOnce(start):
            return SunflowerSeeds.growingOnce(seconds: date.timeIntervalSince(start), seeds: seeds)
        }
    }

    private func disc(startsEmpty: Bool, growth growthFor: @escaping (Int) -> Double) -> some View {
        Canvas { context, size in
            let side = min(size.width, size.height)
            let seeds = SunflowerSeeds.seedCount(forDiameter: side)
            let growth = growthFor(seeds)
            let scale = side * SunflowerSeeds.frameShare / (2 * SunflowerSeeds.reach(seeds: seeds))
            let dx = size.width / 2 - SunflowerSeeds.center * scale
            let dy = size.height / 2 - SunflowerSeeds.center * scale
            for seed in SunflowerSeeds.at(growth: growth, seeds: seeds, startsEmpty: startsEmpty) where seed.radius > 0 {
                let r = seed.radius * scale
                let rect = CGRect(x: dx + seed.x * scale - r, y: dy + seed.y * scale - r, width: r * 2, height: r * 2)
                context.fill(
                    Path(ellipseIn: rect),
                    with: .color(Color(.sRGB, red: seed.red, green: seed.green, blue: seed.blue, opacity: seed.opacity))
                )
            }
        }
        .accessibilityHidden(true)
    }
}

extension EnvironmentValues {
    @Entry public var stillFrames = false
}
