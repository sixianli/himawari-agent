// swift-tools-version: 6.2
import PackageDescription

let coreTargets: [Target] = [
    .target(
        name: "HimawariCore",
        dependencies: [
            .product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux])),
        ]
    ),
    .testTarget(
        name: "HimawariCoreTests",
        dependencies: [
            "HimawariCore",
            .product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux])),
        ],
        resources: [.copy("Fixtures")]
    ),
]

#if os(Linux)
let interfaceTargets: [Target] = []
let interfaceProducts: [Product] = []
#else
let interfaceTargets: [Target] = [
    .target(name: "HimawariDesign", dependencies: ["HimawariCore"], resources: [.process("Resources")]),
    .target(name: "HimawariChat", dependencies: ["HimawariCore", "HimawariDesign"], resources: [.process("Resources")]),
    .target(name: "HimawariManage", dependencies: ["HimawariCore", "HimawariDesign"]),
    .target(name: "HimawariShare", dependencies: ["HimawariCore", "HimawariDesign"], resources: [.process("Resources")]),
    .target(
        name: "HimawariShell",
        dependencies: ["HimawariCore", "HimawariDesign", "HimawariChat", "HimawariManage", "HimawariShare"],
        resources: [.process("Resources")]
    ),
    .target(
        name: "HimawariMacUI",
        dependencies: ["HimawariCore", "HimawariDesign", "HimawariChat", "HimawariShell"],
        resources: [.process("Resources")]
    ),
    .testTarget(name: "HimawariMacUITests", dependencies: ["HimawariMacUI", "HimawariCore"]),
]
let interfaceProducts: [Product] = [
    .library(name: "HimawariDesign", targets: ["HimawariDesign"]),
    .library(name: "HimawariChat", targets: ["HimawariChat"]),
    .library(name: "HimawariManage", targets: ["HimawariManage"]),
    .library(name: "HimawariShare", targets: ["HimawariShare"]),
    .library(name: "HimawariShell", targets: ["HimawariShell"]),
    .library(name: "HimawariMacUI", targets: ["HimawariMacUI"]),
]
#endif

let package = Package(
    name: "HimawariKit",
    defaultLocalization: "zh-Hans",
    platforms: [.iOS(.v26), .macOS(.v26), .watchOS(.v26)],
    products: [.library(name: "HimawariCore", targets: ["HimawariCore"])] + interfaceProducts,
    dependencies: [
        .package(url: "https://github.com/apple/swift-crypto.git", "3.12.0"..<"4.0.0"),
    ],
    targets: coreTargets + interfaceTargets
)
