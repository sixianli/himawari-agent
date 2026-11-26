import Foundation
import SwiftUI

public enum IconName: String, CaseIterable, Sendable {
    case addressBook = "address-book"
    case addressBookLarge = "address-book-large"
    case affiliate
    case alarm
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
    case send
    case server
    case serverLarge = "server-large"
    case share2 = "share-2"
    case settings
    case shieldCheck = "shield-check"
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

    public var weight: Font.Weight {
        switch self {
        case .chevronDown, .chevronLeft, .chevronRight, .arrowUp, .x: .semibold
        default: .regular
        }
    }

    public var symbol: String {
        switch self {
        case .addressBook: "person.text.rectangle"
        case .addressBookLarge: "person.text.rectangle"
        case .affiliate: "point.3.connected.trianglepath.dotted"
        case .alarm: "alarm"
        case .alertCircle: "exclamationmark.circle"
        case .alertCircleLarge: "exclamationmark.circle"
        case .alertTriangle: "exclamationmark.triangle"
        case .appWindow: "macwindow"
        case .arrowBackUp: "arrow.uturn.backward"
        case .arrowUp: "arrow.up"
        case .bell: "bell"
        case .bolt: "bolt"
        case .brandSafari: "safari"
        case .brandSafariLarge: "safari"
        case .bulb: "lightbulb"
        case .calculator: "plus.forwardslash.minus"
        case .calendar: "calendar"
        case .calendarLarge: "calendar"
        case .camera: "camera"
        case .car: "car"
        case .check: "checkmark"
        case .clipboard: "doc.on.clipboard"
        case .clipboardLarge: "doc.on.clipboard"
        case .clipboardList: "list.clipboard"
        case .chevronDown: "chevron.down"
        case .chevronLeft: "chevron.left"
        case .chevronRight: "chevron.right"
        case .circleCheck: "checkmark.circle"
        case .clock: "clock"
        case .compass: "location.north.line"
        case .cloud: "cloud"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .creditCard: "creditcard"
        case .currentLocation: "location"
        case .deviceLaptop: "laptopcomputer"
        case .deviceMobile: "iphone"
        case .deviceMobilePlain: "iphone"
        case .deviceWatch: "applewatch"
        case .download: "arrow.down.circle"
        case .ear: "ear"
        case .earLarge: "ear"
        case .eye: "eye"
        case .faceId: "faceid"
        case .filePencil: "square.and.pencil"
        case .fileSpreadsheet: "tablecells"
        case .fileText: "doc.text"
        case .fingerprint: "touchid"
        case .folder: "folder"
        case .folderSymlink: "folder.badge.person.crop"
        case .handStop: "hand.raised"
        case .heartbeat: "waveform.path.ecg"
        case .heartbeatLarge: "waveform.path.ecg"
        case .history: "clock.arrow.circlepath"
        case .infoCircle: "info.circle"
        case .homeBolt: "homekit"
        case .key: "key"
        case .listCheck: "checklist"
        case .lock: "lock"
        case .mail: "envelope"
        case .mapPin: "mappin"
        case .mapPinLarge: "mappin"
        case .message: "message"
        case .message2: "text.bubble"
        case .messagePlus: "plus.message"
        case .microphone: "mic"
        case .microphoneOff: "mic.slash"
        case .number1: "1.circle"
        case .number2: "2.circle"
        case .number3: "3.circle"
        case .pencil: "pencil"
        case .pencilPlus: "pencil.line"
        case .phone: "phone"
        case .photo: "photo"
        case .photoLarge: "photo"
        case .plane: "airplane"
        case .playerPause: "pause.fill"
        case .playerStop: "stop.fill"
        case .plus: "plus"
        case .point: "circle.fill"
        case .qrcodeOff: "qrcode"
        case .refresh: "arrow.clockwise"
        case .scan: "viewfinder"
        case .search: "magnifyingglass"
        case .send: "paperplane"
        case .server: "server.rack"
        case .serverLarge: "server.rack"
        case .share2: "square.and.arrow.up"
        case .settings: "gearshape"
        case .shieldCheck: "checkmark.shield"
        case .shieldLock: "lock.shield"
        case .stack2: "square.stack"
        case .table: "tablecells"
        case .terminal2: "apple.terminal"
        case .puzzle: "puzzlepiece"
        case .train: "tram"
        case .upload: "arrow.up.circle"
        case .trash: "trash"
        case .user: "person"
        case .users: "person.2"
        case .voiceWave: "waveform"
        case .walk: "figure.walk"
        case .world: "globe"
        case .worldSearch: "text.magnifyingglass"
        case .x: "xmark"
        }
    }
}

public struct Icon: View {
    private let name: IconName
    private let size: CGFloat

    public init(_ name: IconName, size: CGFloat = 26) {
        self.name = name
        self.size = size
    }

    public var body: some View {
        ScaledSymbol(symbol: name.symbol, weight: name.weight, size: size)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .accessibilityHidden(true)
    }
}

struct ScaledSymbol: View {
    static let glyphShare: CGFloat = 0.82

    let symbol: String
    let weight: Font.Weight
    let size: CGFloat
    @ScaledMetric(relativeTo: .body) private var unit: CGFloat = 1

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * unit * Self.glyphShare, weight: weight))
            .symbolRenderingMode(.monochrome)
            .frame(width: size * unit, height: size * unit)
    }
}

public struct ThirdPartyLicense: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let version: String
    public let text: String

    public static var all: [ThirdPartyLicense] {
        [load(id: "cormorant-garamond", name: "Cormorant Garamond")].compactMap { $0 }
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
