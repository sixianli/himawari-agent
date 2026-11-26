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
    .package(url: "https://github.com/appstefan/HighlightSwift.git", exact: "1.2.0"),
]
let interfaceTargets: [Target] = [
    .target(name: "HimawariDesign", dependencies: ["HimawariCore"], resources: [.process("Resources")]),
    .target(
        name: "HimawariChat",
        dependencies: [
            "HimawariCore",
            "HimawariDesign",
            .product(name: "HighlightSwift", package: "HighlightSwift", condition: .when(platforms: [.iOS, .macOS])),
        ],
        resources: [.process("Resources")]
    ),
    .target(name: "HimawariActions", dependencies: ["HimawariCore", "HimawariDesign"]),
    .target(name: "HimawariManage", dependencies: ["HimawariCore", "HimawariDesign", "HimawariActions"], resources: [.process("Resources")]),
    .target(name: "HimawariSenses", dependencies: ["HimawariCore", "HimawariDesign"], resources: [.process("Resources")]),
    .target(name: "HimawariShare", dependencies: ["HimawariCore", "HimawariDesign"], resources: [.process("Resources")]),
    .target(
        name: "HimawariShell",
        dependencies: ["HimawariCore", "HimawariDesign", "HimawariChat", "HimawariManage", "HimawariSenses", "HimawariShare", "HimawariListen", "HimawariListenUI", "HimawariActions"],
        resources: [.process("Resources")]
    ),
    .testTarget(name: "HimawariManageTests", dependencies: ["HimawariManage", "HimawariCore"]),
    .target(
        name: "HimawariMacUI",
        dependencies: ["HimawariCore", "HimawariDesign", "HimawariChat", "HimawariShell"],
        resources: [.process("Resources")]
    ),
    .target(
        name: "HimawariWatchUI",
        dependencies: ["HimawariCore", "HimawariDesign"],
        resources: [.process("Resources")]
    ),
    .testTarget(name: "HimawariMacUITests", dependencies: ["HimawariMacUI", "HimawariCore"]),
    .testTarget(name: "HimawariSensesTests", dependencies: ["HimawariCore", "HimawariSenses"]),
    .target(name: "HimawariListenUI", dependencies: ["HimawariCore", "HimawariDesign"], resources: [.process("Resources")]),
    .testTarget(name: "HimawariListenUITests", dependencies: ["HimawariListenUI"]),
    .target(
        name: "HimawariListen",
        dependencies: [
            "HimawariCore",
            "HimawariDesign",
            "HimawariChat",
            "HimawariListenUI",
            .target(name: "HimawariListenEngine", condition: .when(platforms: [.iOS])),
        ],
        resources: [.process("Resources")]
    ),
    .target(
        name: "HimawariListenEngine",
        dependencies: [
            "HimawariCore",
            .product(name: "FluidAudio", package: "FluidAudio", condition: .when(platforms: [.iOS, .macOS])),
        ],
        resources: [.process("Resources")]
    ),
    .executableTarget(name: "ListenEval", dependencies: ["HimawariCore", "HimawariListenEngine"]),
]
let interfaceProducts: [Product] = [
    .library(name: "HimawariDesign", targets: ["HimawariDesign"]),
    .library(name: "HimawariChat", targets: ["HimawariChat"]),
    .library(name: "HimawariActions", targets: ["HimawariActions"]),
    .library(name: "HimawariManage", targets: ["HimawariManage"]),
    .library(name: "HimawariSenses", targets: ["HimawariSenses"]),
    .library(name: "HimawariShare", targets: ["HimawariShare"]),
    .library(name: "HimawariShell", targets: ["HimawariShell"]),
    .library(name: "HimawariMacUI", targets: ["HimawariMacUI"]),
    .library(name: "HimawariWatchUI", targets: ["HimawariWatchUI"]),
    .library(name: "HimawariListenUI", targets: ["HimawariListenUI"]),
    .library(name: "HimawariListen", targets: ["HimawariListen"]),
    .executable(name: "himawari-listen-eval", targets: ["ListenEval"]),
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
