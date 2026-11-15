import AppIntents
import HimawariListenUI
import HimawariShell
import SwiftUI

@main
struct HimawariApp: App {
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
