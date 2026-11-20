import AppKit
import HimawariMacUI

@main
enum HimawariMacApp {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = MacAppDelegate()
        application.delegate = delegate
        application.run()
    }
}
