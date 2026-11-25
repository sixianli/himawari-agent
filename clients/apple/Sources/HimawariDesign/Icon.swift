import Foundation
import SwiftUI

public enum IconName: String, CaseIterable, Sendable {
    case addressBook = "address-book"
    case addressBookLarge = "address-book-large"
    case affiliate
    case alertCircle = "alert-circle"
    case alertCircleLarge = "alert-circle-large"
    case alertTriangle = "alert-triangle"
    case appWindow = "app-window"
    case arrowBackUp = "arrow-back-up"
    case arrowUp = "arrow-up"
    case bell
    case bolt
    case brandSafari = "brand-safari"
    case brandSafariLarge = "brand-safari-large"
    case bulb
    case calculator
    case calendar
    case calendarFrame = "calendar-frame"
    case calendarLarge = "calendar-large"
    case camera
    case car
    case check
    case clipboard
    case clipboardLarge = "clipboard-large"
    case clipboardList = "clipboard-list"
    case chevronDown = "chevron-down"
    case chevronLeft = "chevron-left"
    case chevronRight = "chevron-right"
    case circleCheck = "circle-check"
    case clock
    case compass
    case cloud
    case code
    case creditCard = "credit-card"
    case currentLocation = "current-location"
    case deviceLaptop = "device-laptop"
    case deviceMobile = "device-mobile"
    case deviceMobilePlain = "device-mobile-plain"
    case deviceWatch = "device-watch"
    case download
    case ear
    case earLarge = "ear-large"
    case eye
    case faceId = "face-id"
    case filePencil = "file-pencil"
    case fileSpreadsheet = "file-spreadsheet"
    case fileText = "file-text"
    case fingerprint
    case folder
    case folderSymlink = "folder-symlink"
    case handStop = "hand-stop"
    case heartbeat
    case heartbeatLarge = "heartbeat-large"
    case history
    case infoCircle = "info-circle"
    case homeBolt = "home-bolt"
    case key
    case listCheck = "list-check"
    case lock
    case mail
    case mapPin = "map-pin"
    case mapPinLarge = "map-pin-large"
    case message
    case message2 = "message-2"
    case messagePlus = "message-plus"
    case microphone
    case microphoneOff = "microphone-off"
    case number1 = "number-1"
    case number2 = "number-2"
    case number3 = "number-3"
    case pencil
    case pencilPlus = "pencil-plus"
    case phone
    case photo
    case photoLarge = "photo-large"
    case plane
    case playerPause = "player-pause"
    case playerStop = "player-stop"
    case plus
    case point
    case qrcodeOff = "qrcode-off"
    case refresh
    case scan
    case search
    case server
    case serverLarge = "server-large"
    case share2 = "share-2"
    case settings
    case shieldLock = "shield-lock"
    case stack2 = "stack-2"
    case table
    case terminal2 = "terminal-2"
    case puzzle
    case train
    case upload
    case trash
    case user
    case users
    case voiceWave = "voice-wave"
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
        [load(id: "tabler-icons", name: "Tabler Icons"), load(id: "cormorant-garamond", name: "Cormorant Garamond")].compactMap { $0 }
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

public enum ChromeIcon {
    public static let newChat: IconName = .messagePlus
}

public struct TodayTabIcon: View {
    private static let grid: CGFloat = 24
    private static let baseline: CGFloat = 17.7
    private static let numberSize: CGFloat = 9.5

    private let day: Int
    private let size: CGFloat

    public init(day: Int, size: CGFloat = 26) {
        self.day = day
        self.size = size
    }

    public var body: some View {
        let scale = size / Self.grid
        let baselineOffset = Self.baseline * scale
        ZStack(alignment: Alignment(horizontal: .center, vertical: .firstTextBaseline)) {
            Icon(.calendarFrame, size: size)
                .alignmentGuide(.firstTextBaseline) { _ in baselineOffset }
            Text(String(day))
                .font(.system(size: Self.numberSize * scale, weight: .bold, design: .rounded))
                .monospacedDigit()
                .fixedSize()
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
