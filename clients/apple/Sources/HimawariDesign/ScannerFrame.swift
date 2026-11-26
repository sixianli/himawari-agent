import SwiftUI

public struct ScannerFrame: View {
    private let caption: Text

    public init(caption: Text) {
        self.caption = caption
    }

    public var body: some View {
        GeometryReader { proxy in
            let side = DesignTokens.Scanner.window
            let window = CGRect(
                x: (proxy.size.width - side) / 2,
                y: (proxy.size.height - side) / 2 - 20,
                width: side,
                height: side
            )
            ZStack {
                Path { path in
                    path.addRect(CGRect(origin: .zero, size: proxy.size))
                    path.addRoundedRect(in: window, cornerSize: CGSize(width: DesignTokens.Scanner.radius, height: DesignTokens.Scanner.radius), style: .continuous)
                }
                .fill(Color.black.opacity(DesignTokens.Scanner.scrimOpacity), style: FillStyle(eoFill: true))
                RoundedRectangle(cornerRadius: DesignTokens.Scanner.radius, style: .continuous)
                    .strokeBorder(Color.white.opacity(DesignTokens.Scanner.strokeOpacity), lineWidth: DesignTokens.Scanner.stroke)
                    .frame(width: side, height: side)
                    .position(x: window.midX, y: window.midY)
                caption
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.white)
                    .position(x: window.midX, y: window.maxY + 28 + DesignTokens.TypeScale.body.size / 2)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

public struct ScannerCloseButton: View {
    private let label: Text
    private let action: () -> Void

    public init(_ label: Text, action: @escaping () -> Void) {
        self.label = label
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Icon(.x, size: DesignTokens.IconSize.glassButton)
                .foregroundStyle(Color.white)
                .frame(width: DesignTokens.Size.glassButton, height: DesignTokens.Size.glassButton)
                .background(Color.white.opacity(DesignTokens.Scanner.closeButtonFillOpacity), in: Circle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(label)
    }
}

public struct CameraStandIn: View {
    public init() {}

    public var body: some View {
        Color.black.ignoresSafeArea()
    }
}
