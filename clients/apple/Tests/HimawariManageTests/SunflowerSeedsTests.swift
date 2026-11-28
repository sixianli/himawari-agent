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
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: 58), 105)
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: 120), 105)
    }

    func testEveryTierDrawsExactlyItsSeedCountAtRest() {
        for seeds in [21, 34, 55, 105] {
            XCTAssertEqual(drawn(seeds).count, seeds)
        }
    }

    func testMoreSeedsAreSmallerSoTheDiscKeepsTheSameSize() {
        let few = drawn(21).map(\.radius).max() ?? 0
        let many = drawn(105).map(\.radius).max() ?? 0
        XCTAssertGreaterThan(few, many)
        let reachFew = drawn(21).map { hypot($0.x - 24, $0.y - 24) + $0.radius }.max() ?? 0
        let reachMany = drawn(105).map { hypot($0.x - 24, $0.y - 24) + $0.radius }.max() ?? 0
        XCTAssertLessThanOrEqual(reachFew, SunflowerSeeds.reach(seeds: 21) + 0.001)
        XCTAssertLessThanOrEqual(reachMany, SunflowerSeeds.reach(seeds: 105) + 0.001)
        XCTAssertEqual(reachFew / SunflowerSeeds.reach(seeds: 21), reachMany / SunflowerSeeds.reach(seeds: 105), accuracy: 0.08)
    }

    func testAFullGrowthCycleTakesTheSameTimeAtEverySize() {
        for seeds in [21, 34, 55, 105] {
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

    func testTheChatPuckBreathesItsOwnHundredAndFiveSeedsInsteadOfTheSizeTier() {
        let seeds = Int(DesignTokens.Chat.puckSeeds)
        XCTAssertEqual(seeds, 105)
        XCTAssertEqual(SunflowerSeeds.seedCount(forDiameter: Double(DesignTokens.Chat.puckMark)), 34)
        XCTAssertEqual(drawn(seeds).count, 105)
        let counts = stride(from: 0.0, through: 20.0, by: 0.05).map {
            visible(SunflowerSeeds.breathing(seconds: $0, seeds: seeds, low: Double(DesignTokens.Chat.puckBusyLow)), seeds)
        }
        XCTAssertEqual(counts.min(), 74)
        XCTAssertEqual(counts.max(), 105)
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
        XCTAssertEqual(visible(SunflowerSeeds.growingOnce(seconds: 0, seeds: 105), 105), 0)
        XCTAssertEqual(SunflowerSeeds.growingOnce(seconds: 1000, seeds: 105), SunflowerSeeds.resting(seeds: 105))
        XCTAssertEqual(visible(SunflowerSeeds.growingOnce(seconds: 1000, seeds: 105), 105), 105)
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

    func testTheNewestSeedsStandOutOnTheLightBackgroundAndStayPaleOnTheDarkOne() {
        let growth = SunflowerSeeds.resting(seeds: 89)
        let newest = { (onLight: Bool) in
            SunflowerSeeds.at(growth: growth, seeds: 89, onLight: onLight).filter { $0.radius > 0 }.min { $0.radius < $1.radius }!
        }
        let lightBackground = luminance(252, 252, 251)
        let light = newest(true)
        XCTAssertGreaterThanOrEqual(contrast(luminance(light.red * 255, light.green * 255, light.blue * 255), lightBackground), 4.5)
        let dark = newest(false)
        XCTAssertEqual([dark.red, dark.green, dark.blue].map { ($0 * 255).rounded() }, [255, 236, 170])
    }

    func testEverySeedButTheNewestIsOneGoldOnDarkAndOneAmberOnLight() {
        let growth = SunflowerSeeds.resting(seeds: 105)
        let colours = { (onLight: Bool) in
            Set(SunflowerSeeds.at(growth: growth, seeds: 105, onLight: onLight)
                .filter { $0.radius > 0 }
                .sorted { $0.radius < $1.radius }
                .dropFirst(7)
                .map { [$0.red, $0.green, $0.blue].map { ($0 * 255).rounded() } })
        }
        XCTAssertEqual(colours(false), [[245, 178, 48]])
        XCTAssertEqual(colours(true), [[210, 124, 18]])
        let amber = luminance(210, 124, 18)
        XCTAssertGreaterThanOrEqual(contrast(amber, luminance(252, 252, 251)), 3)
    }

    private func luminance(_ r: Double, _ g: Double, _ b: Double) -> Double {
        let channel = { (value: Double) -> Double in
            let c = value / 255
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }

    private func contrast(_ a: Double, _ b: Double) -> Double {
        (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
}
