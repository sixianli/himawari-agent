import Foundation

let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 2, let detail = ["full": SunflowerDetail.full, "compact": .compact][arguments.first!] else {
    FileHandle.standardError.write(Data("usage: make-sunflower-svg <full|compact> <out.svg>\n".utf8))
    exit(2)
}
let side = 2 * SunflowerSeeds.reach(detail) / SunflowerSeeds.frameShare
let origin = SunflowerSeeds.center - side / 2
func format(_ value: Double) -> String { String(format: "%.3f", value) }
func channel(_ value: Double) -> Int { Int((value * 255).rounded()) }
var lines = ["<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"\(format(origin)) \(format(origin)) \(format(side)) \(format(side))\">"]
for seed in SunflowerSeeds.at(detail, growth: SunflowerSeeds.resting(detail)) where seed.radius > 0 {
    lines.append("<circle cx=\"\(format(seed.x))\" cy=\"\(format(seed.y))\" r=\"\(format(seed.radius))\" fill=\"rgb(\(channel(seed.red)),\(channel(seed.green)),\(channel(seed.blue)))\" fill-opacity=\"\(format(seed.opacity))\"/>")
}
lines.append("</svg>")
try lines.joined(separator: "\n").appending("\n").write(toFile: String(arguments.last!), atomically: true, encoding: .utf8)
