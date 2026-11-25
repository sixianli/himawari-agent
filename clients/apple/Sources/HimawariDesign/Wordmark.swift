import SwiftUI

public struct Wordmark: View {
    private static let drawnFontSize: CGFloat = 32
    private static let drawnBoxHeight: CGFloat = 48

    private let size: CGFloat
    private let lineHeight: CGFloat?

    public init(size: CGFloat, lineHeight: CGFloat? = nil) {
        self.size = size
        self.lineHeight = lineHeight
    }

    public static func lineBox(size: CGFloat, lineHeight: CGFloat?) -> CGFloat {
        lineHeight.map { size * $0 } ?? size * drawnBoxHeight / drawnFontSize
    }

    public var body: some View {
        Image("wordmark", bundle: .module)
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(height: size * Self.drawnBoxHeight / Self.drawnFontSize)
            .frame(height: Self.lineBox(size: size, lineHeight: lineHeight))
            .foregroundStyle(Color.hmText)
            .accessibilityLabel(Text(verbatim: "himawari"))
            .accessibilityAddTraits(.isHeader)
    }
}
