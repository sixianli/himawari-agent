import Foundation
import SwiftUI

public enum IconName: String, CaseIterable, Sendable {
    case affiliate
    case alertCircle = "alert-circle"
    case arrowUp = "arrow-up"
    case calendar
    case camera
    case chevronLeft = "chevron-left"
    case chevronRight = "chevron-right"
    case circleCheck = "circle-check"
    case edit
    case fileText = "file-text"
    case mapPin = "map-pin"
    case message
    case microphone
    case photo
    case plus
    case scan
    case search
    case server
    case sun
    case user
    case x
}

public struct Icon: View {
    private let name: IconName
    private let size: CGFloat

    public init(_ name: IconName, size: CGFloat = 26) {
        self.name = name
        self.size = size
    }

    public var body: some View {
        Image(name.rawValue, bundle: .module)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

public struct ThirdPartyLicense: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let version: String
    public let text: String

    public static var all: [ThirdPartyLicense] {
        [load(id: "tabler-icons", name: "Tabler Icons")].compactMap { $0 }
    }

    private static func load(id: String, name: String) -> ThirdPartyLicense? {
        guard
            let textURL = Bundle.module.url(forResource: id, withExtension: "txt"),
            let text = try? String(contentsOf: textURL, encoding: .utf8)
        else { return nil }
        let version = Bundle.module.url(forResource: id, withExtension: "version")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8) }?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ThirdPartyLicense(id: id, name: name, version: version, text: text)
    }
}
