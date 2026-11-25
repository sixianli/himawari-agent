import HimawariCore
import SwiftUI

public struct CornerSunflower: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.stillFrames) private var stillFrames

    public init() {}

    public var body: some View {
        Group {
            if reduceMotion || stillFrames {
                flower(sway: 0)
            } else {
                TimelineView(.animation) { context in
                    flower(sway: Self.sway(at: context.date.timeIntervalSinceReferenceDate))
                }
            }
        }
        .frame(width: DesignTokens.Home.flowerWidth, height: DesignTokens.Home.flowerHeight, alignment: .topLeading)
        .clipped()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    static func sway(at seconds: TimeInterval) -> Double {
        let phase = seconds.truncatingRemainder(dividingBy: CornerFlower.swaySeconds) / CornerFlower.swaySeconds
        return -CornerFlower.swayDegrees * cos(phase * 2 * .pi)
    }

    private func flower(sway: Double) -> some View {
        Canvas { context, _ in
            context.translateBy(x: CornerFlower.offset.x, y: CornerFlower.offset.y)
            context.rotate(by: .degrees(sway + CornerFlower.rotationDegrees))
            context.scaleBy(x: CornerFlower.scale, y: CornerFlower.scale)
            for ring in [CornerFlower.back, CornerFlower.front] {
                draw(ring, in: &context)
            }
            let disc = CornerFlower.discRadius
            context.fill(Path(ellipseIn: CGRect(x: -disc, y: -disc, width: disc * 2, height: disc * 2)), with: .color(Self.color(CornerFlower.discColor)))
            for seed in CornerFlower.seeds {
                let rect = CGRect(x: seed.center.x - seed.radius, y: seed.center.y - seed.radius, width: seed.radius * 2, height: seed.radius * 2)
                context.fill(Path(ellipseIn: rect), with: .color(Self.color(seed.color)))
            }
        }
    }

    private func draw(_ ring: CornerFlower.Ring, in context: inout GraphicsContext) {
        let gradient = Gradient(stops: ring.stops.map { Gradient.Stop(color: Self.color($0.color), location: $0.offset) })
        let shading = GraphicsContext.Shading.radialGradient(gradient, center: .zero, startRadius: 0, endRadius: ring.gradientRadius)
        var petals = Path()
        var veins = Path()
        for petal in ring.petals {
            petals.move(to: Self.point(petal.start))
            petals.addCurve(to: Self.point(petal.out.2), control1: Self.point(petal.out.0), control2: Self.point(petal.out.1))
            petals.addCurve(to: Self.point(petal.back.2), control1: Self.point(petal.back.0), control2: Self.point(petal.back.1))
            petals.closeSubpath()
            veins.move(to: Self.point(petal.vein.0))
            veins.addLine(to: Self.point(petal.vein.1))
        }
        context.fill(petals, with: shading)
        context.stroke(petals, with: .color(Self.color(CornerFlower.petalStroke).opacity(CornerFlower.petalStrokeOpacity)), lineWidth: CornerFlower.petalStrokeWidth)
        context.stroke(veins, with: .color(Self.color(CornerFlower.veinStroke).opacity(CornerFlower.veinStrokeOpacity)), lineWidth: CornerFlower.veinStrokeWidth)
    }

    private static func point(_ point: CornerFlower.Point) -> CGPoint {
        CGPoint(x: point.x, y: point.y)
    }

    private static func color(_ hex: UInt32) -> Color {
        Color(
            .sRGB,
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}

public struct Wordmark: View {
    private let height: CGFloat

    public init(height: CGFloat = DesignTokens.Home.wordmarkHeight) {
        self.height = height
    }

    public var body: some View {
        Image("wordmark", bundle: .module)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(height: height)
            .foregroundStyle(Color.hmText)
            .accessibilityLabel(Text(verbatim: "himawari"))
            .accessibilityAddTraits(.isHeader)
    }
}

public struct HomeGlow: View {
    public init() {}

    public var body: some View {
        EllipticalGradient(colors: [Color.hmGlow, Color.hmGlow.opacity(0)], center: .center)
            .frame(width: DesignTokens.Home.glowWidth * 2, height: DesignTokens.Home.glowHeight * 2)
            .offset(x: -DesignTokens.Home.glowWidth, y: DesignTokens.Home.glowCenterY - DesignTokens.Home.glowHeight)
            .frame(width: 0, height: 0, alignment: .topLeading)
            .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
