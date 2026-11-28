import HimawariListenUI
import SwiftUI
import WidgetKit

@main
struct ListenActivityBundle: WidgetBundle {
    var body: some Widget {
        ListenActivityWidget()
        TalkActivityWidget()
        BackgroundWorkActivityWidget()
    }
}
