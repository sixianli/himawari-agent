import Foundation

public struct ThirdPartyLicense: Sendable, Equatable, Identifiable {
    public let name: String
    public let license: String
    public let repository: String

    public var id: String { repository }
}

public enum ThirdPartyLicenses {
    public static let all: [ThirdPartyLicense] = [
        ThirdPartyLicense(name: "HighlightSwift", license: "MIT", repository: "https://github.com/appstefan/HighlightSwift"),
        ThirdPartyLicense(name: "highlight.js", license: "BSD-3-Clause", repository: "https://github.com/highlightjs/highlight.js"),
        ThirdPartyLicense(name: "FluidAudio", license: "Apache-2.0", repository: "https://github.com/FluidInference/FluidAudio"),
        ThirdPartyLicense(name: "swift-crypto", license: "Apache-2.0", repository: "https://github.com/apple/swift-crypto"),
        ThirdPartyLicense(name: "swift-asn1", license: "Apache-2.0", repository: "https://github.com/apple/swift-asn1"),
        ThirdPartyLicense(name: "Noto Serif SC", license: "OFL-1.1", repository: "https://github.com/notofonts/noto-cjk"),
    ]
}
