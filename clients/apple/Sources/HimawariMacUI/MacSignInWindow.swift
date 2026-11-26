#if os(macOS)
import HimawariDesign
import HimawariShell
import SwiftUI

struct MacSignInWindow: View {
    let model: AppModel

    var body: some View {
        SignInView(model: model)
            .frame(width: SignInLayout.macWindowWidth, height: SignInLayout.macWindowHeight)
    }
}
#endif
