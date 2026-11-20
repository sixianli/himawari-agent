import AppIntents
import HimawariListenUI
import HimawariShell
import SwiftUI
import UIKit

@main
struct HimawariApp: App {
    @UIApplicationDelegateAdaptor(HimawariAppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            HimawariRootView()
        }
    }
}

struct HimawariAppIntents: AppIntentsPackage {
    static var includedPackages: [any AppIntentsPackage.Type] {
        [HimawariListenIntents.self]
    }
}
