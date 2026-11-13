import Foundation
import HimawariCore
import Testing

struct CornerFlowerTests {
    private struct Tips: Decodable {
        let back: [[Double]]
        let front: [[Double]]
    }

    private func rounded(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }

    @Test func petalsLandWhereThePrototypeDrewThem() throws {
        let url = try #require(Bundle.module.url(forResource: "corner-flower-tips", withExtension: "json", subdirectory: "Fixtures"))
        let tips = try JSONDecoder().decode(Tips.self, from: Data(contentsOf: url))
        for (ring, expected) in [(CornerFlower.back, tips.back), (CornerFlower.front, tips.front)] {
            #expect(ring.petals.count == expected.count)
            for (petal, tip) in zip(ring.petals, expected) {
                #expect(abs(rounded(petal.out.2.x) - tip[0]) < 0.011)
                #expect(abs(rounded(petal.out.2.y) - tip[1]) < 0.011)
            }
        }
    }

    @Test func seedsFillTheDiscWithoutLeavingIt() {
        #expect(CornerFlower.seeds.count == 230)
        for seed in CornerFlower.seeds {
            let distance = (seed.center.x * seed.center.x + seed.center.y * seed.center.y).squareRoot()
            #expect(distance + seed.radius <= CornerFlower.discRadius + 0.5)
        }
    }
}
