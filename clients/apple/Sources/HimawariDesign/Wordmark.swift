import SwiftUI

public struct Wordmark: View {
    private let height: CGFloat

    public init(height: CGFloat = DesignTokens.Home.wordmarkHeight) {
        self.height = height
    }

    public var body: some View {
        Image("wordmark", bundle: .module)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(height: height)
            .foregroundStyle(Color.hmText)
            .accessibilityLabel(Text(verbatim: "himawari"))
            .accessibilityAddTraits(.isHeader)
    }
}
