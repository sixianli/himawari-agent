import Foundation

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
    public static let seedCount = 55
    static let goldenAngle = Double.pi * (3 - 5.0.squareRoot())
    static let center = 24.0
    static let discRadius = 19.7
    static let newestShare = 0.06
    static let birthSeconds = 1.2
    static let fadeSeeds = 1.5
    static let smallestSeed = 0.8
    static let seedGrowth = 1.33
    static let frameShare = 0.94
    static let newSeed = (255.0, 236.0, 170.0)
    static let brown = (92.0, 52.0, 16.0)
    static let amber = (214.0, 128.0, 20.0)
    static let gold = (245.0, 178.0, 48.0)

    static let tiers: [(diameter: Double, seeds: Int)] = [(28, 21), (46, 34), (56, 55), (72, 89)]
    static let largestTier = 144
    public static let fullGrowthSeconds = 16.0
    public static let idleShareOfGrowth = 0.125

    public static func seedCount(forDiameter diameter: Double) -> Int {
        tiers.first { diameter <= $0.diameter }?.seeds ?? largestTier
    }

    static func seedScale(_ seeds: Int) -> Double {
        (Double(seedCount) / Double(seeds)).squareRoot()
    }

    public static func reach(seeds: Int = seedCount) -> Double {
        discRadius + (smallestSeed + seedGrowth) * seedScale(seeds)
    }

    public static func resting(seeds: Int = seedCount) -> Double {
        Double(seeds + 8)
    }

    public static func growthPerSecond(seeds: Int) -> Double {
        Double(seeds) / fullGrowthSeconds
    }

    public static func idling(seconds: Double, seeds: Int) -> Double {
        resting(seeds: seeds) + max(0, seconds) * growthPerSecond(seeds: seeds) * idleShareOfGrowth
    }

    public static func breathing(seconds: Double, seeds: Int, low: Double) -> Double {
        let count = Double(seeds)
        let rate = growthPerSecond(seeds: seeds)
        let leg = count * (1 - low) / rate
        guard leg > 0 else { return count }
        let phase = abs(seconds).truncatingRemainder(dividingBy: 2 * leg)
        let rising = phase <= leg ? phase : 2 * leg - phase
        return count * low + rising * rate
    }

    public static func growingOnce(seconds: Double, seeds: Int) -> Double {
        min(resting(seeds: seeds), max(0, seconds) * growthPerSecond(seeds: seeds))
    }

    public static var reach: Double { reach() }
    public static var resting: Double { resting() }

    public static func at(growth: Double, seeds: Int = seedCount, startsEmpty: Bool = false) -> [SunflowerSeed] {
        let count = Double(seeds)
        let spacing = discRadius / count.squareRoot()
        let seedScale = seedScale(seeds)
        let newest = growth.rounded(.down)
        return (0..<(seeds + 2)).compactMap { (slot: Int) -> SunflowerSeed? in
            let order = newest - Double(slot)
            let age = growth - order
            guard age >= 0, age <= count, !startsEmpty || order >= 0 else { return nil }
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
                radius: (smallestSeed + seedGrowth * share.squareRoot()) * seedScale * born,
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
