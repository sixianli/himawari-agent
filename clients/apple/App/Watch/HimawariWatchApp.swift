import HimawariWatchUI
import SwiftUI
import WatchKit

@main
struct HimawariWatchApp: App {
    @State private var model = WatchModel()
    @WKApplicationDelegateAdaptor private var delegate: WatchAppDelegate

    private var live: some View {
        WatchRootView(model: model)
            .onAppear { delegate.attach(model) }
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if let scene = WatchDemoScene.requested {
                WatchDemoView(scene: scene)
            } else {
                live
            }
            #else
            live
            #endif
        }
        .backgroundTask(.appRefresh("himawari.home")) {
            await delegate.refreshInBackground()
        }
    }
}
