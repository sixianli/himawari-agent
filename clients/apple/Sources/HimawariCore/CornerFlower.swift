import Foundation

public enum CornerFlower {
    public struct Point: Sendable, Equatable {
        public let x: Double
        public let y: Double
    }

    public struct Petal: Sendable, Equatable {
        public let start: Point
        public let out: (Point, Point, Point)
        public let back: (Point, Point, Point)
        public let vein: (Point, Point)

        public static func == (a: Petal, b: Petal) -> Bool {
            a.start == b.start && a.out == b.out && a.back == b.back && a.vein == b.vein
        }
    }

    public struct Seed: Sendable, Equatable {
        public let center: Point
        public let radius: Double
        public let color: UInt32
    }

    public struct Ring: Sendable, Equatable {
        public let petals: [Petal]
        public let gradientRadius: Double
        public let stops: [(offset: Double, color: UInt32)]

        public static func == (a: Ring, b: Ring) -> Bool {
            a.petals == b.petals && a.gradientRadius == b.gradientRadius
                && a.stops.map(\.offset) == b.stops.map(\.offset) && a.stops.map(\.color) == b.stops.map(\.color)
        }
    }

    public static let offset = Point(x: -10, y: 26)
    public static let rotationDegrees = 9.0
    public static let scale = 1.12
    public static let swayDegrees = 2.2
    public static let swaySeconds = 9.0
    public static let petalStroke: UInt32 = 0xb97708
    public static let petalStrokeOpacity = 0.45
    public static let petalStrokeWidth = 0.5
    public static let veinStroke: UInt32 = 0xb06f06
    public static let veinStrokeOpacity = 0.35
    public static let veinStrokeWidth = 0.6
    public static let discRadius = 39.0
    public static let discColor: UInt32 = 0x3f2705

    static let goldenAngle = Double.pi * (3 - 5.0.squareRoot())

    public static let back = Ring(
        petals: ring(count: 21, inner: 36, outer: 100, halfWidth: 12.5, rotation: 0.15, seed: 7),
        gradientRadius: 100,
        stops: [(0.38, 0xc27a08), (0.7, 0xe5a318), (1, 0xf0bd35)]
    )

    public static let front = Ring(
        petals: ring(count: 21, inner: 36, outer: 88, halfWidth: 13, rotation: 0, seed: 3),
        gradientRadius: 92,
        stops: [(0.38, 0xdc8f0c), (0.62, 0xf2b41d), (1, 0xfad452)]
    )

    public static let seeds: [Seed] = {
        let count = 230
        let reach = 37.5
        return (0..<count).map { index in
            let t = ((Double(index) + 0.5) / Double(count)).squareRoot()
            let angle = Double(index) * goldenAngle
            let color: UInt32
            if t < 0.42 {
                color = index % 2 == 1 ? 0x8b7424 : 0x6f5a16
            } else if t < 0.8 {
                color = index % 3 != 0 ? 0x6b4208 : 0x553305
            } else {
                color = index % 3 != 0 ? 0xd2920f : 0xeab52f
            }
            return Seed(
                center: Point(x: reach * t * cos(angle), y: reach * t * sin(angle)),
                radius: 0.9 + t * 0.95,
                color: color
            )
        }
    }()

    static func random(seed: UInt32) -> () -> Double {
        var state = seed
        return {
            state = state &+ 0x6d2b79f5
            var t = (state ^ (state >> 15)) &* (1 | state)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Double(t ^ (t >> 14)) / 4_294_967_296
        }
    }

    static func ring(count: Int, inner: Double, outer: Double, halfWidth: Double, rotation: Double, seed: UInt32) -> [Petal] {
        let next = random(seed: seed)
        return (0..<count).map { index in
            let angle = rotation + Double(index) * Double.pi * 2 / Double(count) + (next() - 0.5) * 0.09
            let length = outer * (1 - next() * 0.1)
            let width = halfWidth * (0.92 + next() * 0.16)
            return petal(angle: angle, inner: inner, outer: length, halfWidth: width)
        }
    }

    static func petal(angle: Double, inner: Double, outer: Double, halfWidth: Double) -> Petal {
        let direction = (cos(angle), sin(angle))
        let normal = (-direction.1, direction.0)
        func at(_ along: Double, _ side: Double) -> Point {
            Point(x: direction.0 * along + normal.0 * side, y: direction.1 * along + normal.1 * side)
        }
        let span = outer - inner
        return Petal(
            start: at(inner, 0),
            out: (at(inner + span * 0.16, halfWidth * 0.9), at(inner + span * 0.6, halfWidth), at(outer, 0)),
            back: (at(inner + span * 0.6, -halfWidth), at(inner + span * 0.16, -halfWidth * 0.9), at(inner, 0)),
            vein: (Point(x: cos(angle) * (inner + 6), y: sin(angle) * (inner + 6)), Point(x: cos(angle) * outer * 0.78, y: sin(angle) * outer * 0.78))
        )
    }
}
