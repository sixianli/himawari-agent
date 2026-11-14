import Foundation
import SwiftUI

public enum IconName: String, CaseIterable, Sendable {
    case affiliate
    case alertCircle = "alert-circle"
    case alertCircleLarge = "alert-circle-large"
    case arrowUp = "arrow-up"
    case bell
    case bolt
    case bulb
    case calculator
    case calendar
    case camera
    case car
    case check
    case checklist
    case chevronLeft = "chevron-left"
    case chevronRight = "chevron-right"
    case circleCheck = "circle-check"
    case cloud
    case creditCard = "credit-card"
    case currentLocation = "current-location"
    case deviceLaptop = "device-laptop"
    case deviceMobile = "device-mobile"
    case deviceWatch = "device-watch"
    case download
    case ear
    case edit
    case eye
    case faceId = "face-id"
    case filePencil = "file-pencil"
    case fileText = "file-text"
    case handStop = "hand-stop"
    case heartRateMonitor = "heart-rate-monitor"
    case history
    case homeBolt = "home-bolt"
    case listCheck = "list-check"
    case mail
    case mapPin = "map-pin"
    case message
    case message2 = "message-2"
    case microphone
    case pencilPlus = "pencil-plus"
    case phone
    case photo
    case plane
    case playerStop = "player-stop"
    case plus
    case qrcodeOff = "qrcode-off"
    case scan
    case search
    case server
    case serverLarge = "server-large"
    case stack2 = "stack-2"
    case sun
    case table
    case terminal2 = "terminal-2"
    case tools
    case train
    case upload
    case user
    case users
    case walk
    case world
    case worldSearch = "world-search"
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
