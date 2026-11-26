#if os(macOS)
import HimawariDesign
import SwiftUI

public struct MacScenes: Scene {
    static let mainWindow = "main"
    private let delegate: MacAppDelegate

    public init(delegate: MacAppDelegate) {
        self.delegate = delegate
    }

    public var body: some Scene {
        Window(L.text("app.name"), id: Self.mainWindow) {
            MacMainView(main: delegate.main) { delegate.register($0, $1) }
        }
        .defaultSize(width: DesignTokens.Mac.windowMinWidth, height: DesignTokens.Mac.windowMinHeight)
        .commands {
            SidebarCommands()
            CommandGroup(replacing: .newItem) {}
            MacGoCommands(main: delegate.main)
        }
        Settings {
            MacSettingsWindow(menu: delegate.menu, main: delegate.main)
        }
    }
}

struct MacGoCommands: Commands {
    let main: MacMainModel

    var body: some Commands {
        CommandMenu(L.text("menu.go")) {
            let destinations = main.destinations
            ForEach(destinations.indices, id: \.self) { index in
                let destination = destinations[index]
                let button = Button(MacSidebarText.title(destination)) { main.go(to: destination) }
                if index < 9 {
                    button.keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                } else {
                    button
                }
            }
        }
    }
}
#endif
