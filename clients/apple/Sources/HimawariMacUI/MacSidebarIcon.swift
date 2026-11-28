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
        case .her(.memory):
            Image(systemName: "brain")
        case .her(.rules):
            Image(systemName: "list.bullet.clipboard")
        case .her(.approvals):
            Icon(.handStop, size: DesignTokens.Mac.settingsIcon)
        case .her(.timers):
            Image(systemName: "alarm")
        case .her(.allowances):
            Image(systemName: "checkmark.shield")
        case .her(.vault):
            Image(systemName: "key")
        case .her(.notifications):
            Image(systemName: "bell")
        case .her(.privacy):
            Image(systemName: "hand.raised")
        case .her(.about):
            Image(systemName: "info.circle")
        }
    }
}
#endif
