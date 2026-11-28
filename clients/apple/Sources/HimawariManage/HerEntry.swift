import HimawariDesign

enum HerEntryGroup: String, CaseIterable, Sendable {
    case files
    case using
    case guarding
    case about
}

enum HerEntry: String, CaseIterable, Sendable {
    case files
    case personalization
    case notifications
    case voice
    case dataAndApps
    case passwords
    case noMoreAsking
    case yourData
    case devices
    case about

    var group: HerEntryGroup {
        switch self {
        case .files: .files
        case .personalization, .notifications, .voice, .dataAndApps: .using
        case .passwords, .noMoreAsking, .yourData, .devices: .guarding
        case .about: .about
        }
    }

    var title: String {
        switch self {
        case .files: M.filesTitle
        case .personalization: M.personalizationTitle
        case .notifications: M.notificationsTitle
        case .voice: M.voiceTitle
        case .dataAndApps: M.dataAndAppsTitle
        case .passwords: M.vaultTitle
        case .noMoreAsking: M.allowancesTitle
        case .yourData: M.yourDataTitle
        case .devices: M.devicesTitle
        case .about: M.aboutTitle
        }
    }

    var icon: IconName {
        switch self {
        case .files: .photo
        case .personalization: .user
        case .notifications: .bell
        case .voice: .microphone
        case .dataAndApps: .puzzle
        case .passwords: .key
        case .noMoreAsking: .shieldCheck
        case .yourData: .download
        case .devices: .deviceMobilePlain
        case .about: .infoCircle
        }
    }

    static func entries(in group: HerEntryGroup) -> [HerEntry] {
        allCases.filter { $0.group == group }
    }
}
