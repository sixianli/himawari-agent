import SwiftUI

public struct SunflowerMark: View {
    private let growing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.stillFrames) private var stillFrames

    public init(growing: Bool = false) {
        self.growing = growing
    }

    public var body: some View {
        if growing && !reduceMotion && !stillFrames {
            TimelineView(.animation) { context in
                disc(seconds: context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10_000))
            }
        } else {
            disc(seconds: 0)
        }
    }

    private func disc(seconds: Double) -> some View {
        Canvas { context, size in
            let side = min(size.width, size.height)
            let seeds = SunflowerSeeds.seedCount(forDiameter: side)
            let growth = SunflowerSeeds.resting(seeds: seeds) + seconds * SunflowerSeeds.growthPerSecond(seeds: seeds)
            let scale = side * SunflowerSeeds.frameShare / (2 * SunflowerSeeds.reach(seeds: seeds))
            let dx = size.width / 2 - SunflowerSeeds.center * scale
            let dy = size.height / 2 - SunflowerSeeds.center * scale
            for seed in SunflowerSeeds.at(growth: growth, seeds: seeds) where seed.radius > 0 {
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
