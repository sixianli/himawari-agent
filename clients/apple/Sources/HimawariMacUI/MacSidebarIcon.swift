#if os(macOS)
import HimawariDesign
import HimawariManage
import SwiftUI

struct MacSidebarIcon: View {
    let destination: MacDestination

    var body: some View {
        switch destination {
        case .chat:
            Image(systemName: "text.bubble")
        case .her(.approvals):
            Icon(.handStop, size: DesignTokens.Mac.settingsIcon)
        case .her(.personalization):
            Image(systemName: "person.crop.circle")
        case .her(.notifications):
            Image(systemName: "bell")
        case .her(.passwords):
            Image(systemName: "key")
        case .her(.noMoreAsking):
            Image(systemName: "checkmark.shield")
        case .her(.about):
            Image(systemName: "info.circle")
        }
    }
}
#endif
