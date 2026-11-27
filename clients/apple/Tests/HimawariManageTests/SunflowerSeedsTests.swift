import HimawariDesign
import XCTest

final class SunflowerSeedsTests: XCTestCase {
    private func drawn(_ seeds: Int) -> [SunflowerSeed] {
        SunflowerSeeds.at(growth: SunflowerSeeds.resting(seeds: seeds), seeds: seeds).filter { $0.radius > 0 }
    }

    func testSmallMarksUseFewerSeedsAndLargeMarksUseMore() {
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: 24), 21)
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: 28), 21)
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: 38), 34)
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: 48), 55)
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: 58), 89)
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: 120), 144)
    }

    func testEveryTierDrawsExactlyItsSeedCountAtRest() {
        for seeds in [21, 34, 55, 89, 144] {
            XCTAssertEqual(drawn(seeds).count, seeds)
        }
    }

    func testMoreSeedsAreSmallerSoTheDiscKeepsTheSameSize() {
        let few = drawn(21).map(\.radius).max() ?? 0
        let many = drawn(144).map(\.radius).max() ?? 0
        XCTAssertGreaterThan(few, many)
        let reachFew = drawn(21).map { hypot($0.x - 24, $0.y - 24) + $0.radius }.max() ?? 0
        let reachMany = drawn(144).map { hypot($0.x - 24, $0.y - 24) + $0.radius }.max() ?? 0
        XCTAssertLessThanOrEqual(reachFew, SunflowerSeeds.reach(seeds: 21) + 0.001)
        XCTAssertLessThanOrEqual(reachMany, SunflowerSeeds.reach(seeds: 144) + 0.001)
        XCTAssertEqual(reachFew / SunflowerSeeds.reach(seeds: 21), reachMany / SunflowerSeeds.reach(seeds: 144), accuracy: 0.08)
    }

    func testAFullGrowthCycleTakesTheSameTimeAtEverySize() {
        for seeds in [21, 34, 55, 89, 144] {
            XCTAssertEqual(Double(seeds) / SunflowerSeeds.growthPerSecond(seeds: seeds), SunflowerSeeds.fullGrowthSeconds, accuracy: 0.0001)
        }
    }

    private func visible(_ growth: Double, _ seeds: Int) -> Int {
        SunflowerSeeds.at(growth: growth, seeds: seeds, startsEmpty: true).filter { $0.radius > 0 }.count
    }

    func testBusyMarkBreathesBetweenSeventyPercentAndTheWholeFlower() {
        let counts = stride(from: 0.0, through: 20.0, by: 0.05).map {
            visible(SunflowerSeeds.breathing(seconds: $0, seeds: 34, low: 0.7), 34)
        }
        XCTAssertEqual(counts.min(), 24)
        XCTAssertEqual(counts.max(), 34)
    }

    func testTheChatPuckBreathesItsOwnEightyNineSeedsInsteadOfTheSizeTier() {
        let seeds = Int(DesignTokens.Chat.puckSeeds)
        XCTAssertEqual(seeds, 89)
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: Double(DesignTokens.Chat.puckMark)), 34)
        XCTAssertEqual(drawn(seeds).count, 89)
        let counts = stride(from: 0.0, through: 20.0, by: 0.05).map {
            visible(SunflowerSeeds.breathing(seconds: $0, seeds: seeds, low: Double(DesignTokens.Chat.puckBusyLow)), seeds)
        }
        XCTAssertEqual(counts.min(), 63)
        XCTAssertEqual(counts.max(), 89)
        let leg = Double(seeds) * (1 - Double(DesignTokens.Chat.puckBusyLow)) / SunflowerSeeds.growthPerSecond(seeds: seeds)
        XCTAssertEqual(leg, SunflowerSeeds.fullGrowthSeconds * 0.3, accuracy: 0.0001)
    }

    func testBreathingMovesAtTheUsualGrowthSpeed() {
        let leg = 34 * 0.3 / SunflowerSeeds.growthPerSecond(seeds: 34)
        XCTAssertEqual(SunflowerSeeds.breathing(seconds: 0, seeds: 34, low: 0.7), 34 * 0.7, accuracy: 0.0001)
        XCTAssertEqual(SunflowerSeeds.breathing(seconds: leg, seeds: 34, low: 0.7), 34, accuracy: 0.0001)
        XCTAssertEqual(SunflowerSeeds.breathing(seconds: 2 * leg, seeds: 34, low: 0.7), 34 * 0.7, accuracy: 0.0001)
    }

    func testTheEmptyChatFlowerGrowsOnceAndStaysWhole() {
        XCTAssertEqual(visible(SunflowerSeeds.growingOnce(seconds: 0, seeds: 144), 144), 0)
        XCTAssertEqual(SunflowerSeeds.growingOnce(seconds: 1000, seeds: 144), SunflowerSeeds.resting(seeds: 144))
        XCTAssertEqual(visible(SunflowerSeeds.growingOnce(seconds: 1000, seeds: 144), 144), 144)
    }

    func testAnIdleMarkKeepsGrowingNewSeedsMoreSlowlyThanAnAnsweringOne() {
        let seeds = 89
        let rest = SunflowerSeeds.resting(seeds: seeds)
        XCTAssertEqual(SunflowerSeeds.idling(seconds: 0, seeds: seeds), rest)
        let idleAfterTen = SunflowerSeeds.idling(seconds: 10, seeds: seeds)
        let busyAfterTen = rest + 10 * SunflowerSeeds.growthPerSecond(seeds: seeds)
        XCTAssertGreaterThan(idleAfterTen, rest + 1)
        XCTAssertLessThan(idleAfterTen, busyAfterTen)
        XCTAssertGreaterThan(SunflowerSeeds.idling(seconds: 60, seeds: seeds), idleAfterTen)
    }
}
