import SwiftUI

public struct SunflowerMark: View {
    private let detail: SunflowerDetail
    private let growing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.stillFrames) private var stillFrames

    public init(detail: SunflowerDetail = .full, growing: Bool = false) {
        self.detail = detail
        self.growing = growing
    }

    public var body: some View {
        if growing && !reduceMotion && !stillFrames {
            TimelineView(.animation) { context in
                disc(growth: SunflowerSeeds.resting(detail) + context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10_000) * 7)
            }
        } else {
            disc(growth: SunflowerSeeds.resting(detail))
        }
    }

    private func disc(growth: Double) -> some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) * SunflowerSeeds.frameShare / (2 * SunflowerSeeds.reach(detail))
            let dx = size.width / 2 - SunflowerSeeds.center * scale
            let dy = size.height / 2 - SunflowerSeeds.center * scale
            for seed in SunflowerSeeds.at(detail, growth: growth) where seed.radius > 0 {
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
