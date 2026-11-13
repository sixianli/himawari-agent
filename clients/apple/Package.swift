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
let interfaceDependencies: [Package.Dependency] = []
#else
let interfaceDependencies: [Package.Dependency] = [
    .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.3", traits: ["Diarizer"]),
]
let interfaceTargets: [Target] = [
    .target(name: "HimawariDesign", dependencies: ["HimawariCore"], resources: [.process("Resources")]),
    .target(name: "HimawariChat", dependencies: ["HimawariCore", "HimawariDesign"], resources: [.process("Resources")]),
    .target(name: "HimawariManage", dependencies: ["HimawariCore", "HimawariDesign"]),
    .target(
        name: "HimawariShell",
        dependencies: ["HimawariCore", "HimawariDesign", "HimawariChat", "HimawariManage", "HimawariListen", "HimawariListenUI"],
        resources: [.process("Resources")]
    ),
    .target(
        name: "HimawariMacUI",
        dependencies: ["HimawariCore", "HimawariDesign", "HimawariChat", "HimawariShell"],
        resources: [.process("Resources")]
    ),
    .testTarget(name: "HimawariMacUITests", dependencies: ["HimawariMacUI", "HimawariCore"]),
    .target(name: "HimawariListenUI", dependencies: ["HimawariCore", "HimawariDesign"], resources: [.process("Resources")]),
    .target(
        name: "HimawariListen",
        dependencies: [
            "HimawariCore",
            "HimawariDesign",
            "HimawariChat",
            "HimawariListenUI",
            .product(name: "FluidAudio", package: "FluidAudio", condition: .when(platforms: [.iOS])),
        ],
        resources: [.process("Resources")]
    ),
]
let interfaceProducts: [Product] = [
    .library(name: "HimawariDesign", targets: ["HimawariDesign"]),
    .library(name: "HimawariChat", targets: ["HimawariChat"]),
    .library(name: "HimawariManage", targets: ["HimawariManage"]),
    .library(name: "HimawariShell", targets: ["HimawariShell"]),
    .library(name: "HimawariMacUI", targets: ["HimawariMacUI"]),
    .library(name: "HimawariListenUI", targets: ["HimawariListenUI"]),
    .library(name: "HimawariListen", targets: ["HimawariListen"]),
]
#endif

let package = Package(
    name: "HimawariKit",
    defaultLocalization: "zh-Hans",
    platforms: [.iOS(.v26), .macOS(.v26), .watchOS(.v26)],
    products: [.library(name: "HimawariCore", targets: ["HimawariCore"])] + interfaceProducts,
    dependencies: [
        .package(url: "https://github.com/apple/swift-crypto.git", "3.12.0"..<"4.0.0"),
    ] + interfaceDependencies,
    targets: coreTargets + interfaceTargets
)
