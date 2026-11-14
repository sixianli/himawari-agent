import Foundation

public enum SunflowerDetail: Sendable {
    case full
    case compact

    var seedCount: Int { self == .full ? 233 : 89 }
    var sizeScale: Double { self == .full ? 1 : 1.25 }
}

public struct SunflowerSeed: Sendable, Equatable {
    public let x: Double
    public let y: Double
    public let radius: Double
    public let red: Double
    public let green: Double
    public let blue: Double
    public let opacity: Double
}

public enum SunflowerSeeds {
    static let goldenAngle = Double.pi * (3 - 5.0.squareRoot())
    static let center = 24.0
    static let discRadius = 19.7
    static let newestShare = 0.06
    static let birthSeconds = 1.2
    static let fadeSeeds = 6.0
    static let smallestSeed = 0.43
    static let seedGrowth = 0.72
    static let frameShare = 0.94
    static let newSeed = (255.0, 236.0, 170.0)
    static let brown = (92.0, 52.0, 16.0)
    static let amber = (214.0, 128.0, 20.0)
    static let gold = (245.0, 178.0, 48.0)

    public static func reach(_ detail: SunflowerDetail) -> Double {
        discRadius + (smallestSeed + seedGrowth) * detail.sizeScale
    }

    public static func resting(_ detail: SunflowerDetail) -> Double {
        Double(detail.seedCount + 8)
    }

    public static func at(_ detail: SunflowerDetail, growth: Double) -> [SunflowerSeed] {
        let count = Double(detail.seedCount)
        let spacing = discRadius / count.squareRoot()
        let newest = growth.rounded(.down)
        return (0..<(detail.seedCount + 2)).compactMap { (slot: Int) -> SunflowerSeed? in
            let order = newest - Double(slot)
            let age = growth - order
            guard age >= 0, age <= count else { return nil }
            let share = age / count
            let distance = spacing * age.squareRoot()
            let angle = order * goldenAngle
            let born = clamp(age / birthSeconds)
            let color: (Double, Double, Double)
            if share < newestShare {
                color = newSeed
            } else if share < 0.5 {
                color = blend(brown, amber, share / 0.5)
            } else {
                color = blend(amber, gold, (share - 0.5) / 0.5)
            }
            return SunflowerSeed(
                x: center + distance * cos(angle),
                y: center + distance * sin(angle),
                radius: (smallestSeed + seedGrowth * share.squareRoot()) * detail.sizeScale * born,
                red: color.0 / 255,
                green: color.1 / 255,
                blue: color.2 / 255,
                opacity: clamp((count - age) / fadeSeeds)
            )
        }
    }

    static func clamp(_ value: Double) -> Double { max(0, min(1, value)) }

    static func blend(_ from: (Double, Double, Double), _ to: (Double, Double, Double), _ share: Double) -> (Double, Double, Double) {
        let s = clamp(share)
        return (
            (from.0 + (to.0 - from.0) * s).rounded(),
            (from.1 + (to.1 - from.1) * s).rounded(),
            (from.2 + (to.2 - from.2) * s).rounded()
        )
    }
}
