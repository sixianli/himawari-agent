import HimawariMacUI
import SwiftUI

@main
struct HimawariMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var delegate

    var body: some Scene {
        MacScenes(delegate: delegate)
    }
}
