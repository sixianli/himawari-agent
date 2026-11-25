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
}
