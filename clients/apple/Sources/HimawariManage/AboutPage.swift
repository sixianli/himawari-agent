import HimawariCore
import HimawariDesign
import SwiftUI

struct AboutPage: View {
    let server: String?
    let openTiming: () -> Void
    let back: () -> Void
    @AppStorage(AboutPage.developerModeKey) private var developerMode = false
    @Environment(\.openURL) private var openURL

    static let developerModeKey = "about.developerMode"

    static var versionLine: String? {
        let info = Bundle.main.infoDictionary
        guard let version = info?["CFBundleShortVersionString"] as? String else { return nil }
        guard let build = info?["CFBundleVersion"] as? String else { return version }
        return "\(version) (\(build))"
    }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.aboutTitle, leading: .back, action: back)
            SettingsGroup(label: nil) {
                SettingsRow(icon: nil, title: M.aboutVersion, value: Self.versionLine ?? "-")
                SettingsRow(icon: nil, title: M.aboutServer, detail: server ?? M.aboutNotConnected, last: true)
            }
            SettingsGroup(label: M.aboutLicenses) {
                ForEach(Array(ThirdPartyLicenses.all.enumerated()), id: \.element.id) { index, item in
                    Button {
                        if let url = URL(string: item.repository) { openURL(url) }
                    } label: {
                        SettingsRow(icon: nil, title: item.name, value: item.license, chevron: true, last: index == ThirdPartyLicenses.all.count - 1)
                    }
                    .buttonStyle(.pressable)
                }
            }
            if developerMode {
                SettingsGroup(label: M.developer) {
                    Button(action: openTiming) {
                        HerRow(icon: .stopwatch, title: M.talkTiming, last: true)
                    }
                    .buttonStyle(.pressable)
                }
            }
            SettingsGroup(label: nil) {
                SettingsRow(icon: nil, title: M.developerMode, switchState: $developerMode, last: true)
            }
        }
    }
}
