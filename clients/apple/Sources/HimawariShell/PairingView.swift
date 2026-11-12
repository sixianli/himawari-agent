import HimawariCore
import HimawariDesign
import SwiftUI
#if canImport(VisionKit)
import VisionKit
#endif

struct PairingView: View {
    let model: AppModel
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 40)
            SunflowerMark(detail: .full, growing: model.phase == .submitting)
                .frame(width: 140, height: 140)
                .padding(.bottom, 44)
            Text(L.text("pairing.hello"))
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(Color.hmText)
                .multilineTextAlignment(.center)
            Text(L.text("pairing.subtitle"))
                .font(.system(size: 17))
                .foregroundStyle(Color.hmMuted)
                .multilineTextAlignment(.center)
                .padding(.top, 10)
            steps
                .padding(.top, 40)
            statusMessage
                .padding(.top, 20)
            Spacer(minLength: 24)
            action
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            ZStack {
                Color.hmBackground
                RadialGradient(colors: [Color.hmGlow, .clear], center: UnitPoint(x: 0.5, y: 0.22), startRadius: 0, endRadius: 320)
            }
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $scanning) {
            PairingScanner { text in
                scanning = false
                model.pair(scanned: text)
            } cancel: {
                scanning = false
            }
        }
    }

    private var steps: some View {
        VStack(spacing: 0) {
            ForEach(1...3, id: \.self) { index in
                HStack(spacing: 24) {
                    Text(index, format: .number)
                        .font(.rounded(17, weight: .bold))
                        .foregroundStyle(Color.hmSun)
                        .frame(width: 16, alignment: .leading)
                    Text(L.text("pairing.step\(index)"))
                        .font(.system(size: 17))
                        .foregroundStyle(Color.hmText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 56)
                if index < 3 { RowSeparator() }
            }
        }
        .himawariCard(padding: EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
    }

    @ViewBuilder
    private var statusMessage: some View {
        switch model.phase {
        case let .unpaired(problem?):
            Text(L.text("pairing.problem.\(Self.key(problem))"))
                .font(.system(size: 15))
                .foregroundStyle(Color.hmDanger)
                .multilineTextAlignment(.center)
        case let .waitingForConfirmation(number):
            VStack(spacing: 6) {
                Text(L.text("pairing.waiting"))
                    .font(.system(size: 15))
                    .foregroundStyle(Color.hmMuted)
                Text(number)
                    .font(.rounded(34, weight: .bold))
                    .foregroundStyle(Color.hmText)
                    .accessibilityLabel(Text(number.replacingOccurrences(of: " ", with: "")))
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var action: some View {
        switch model.phase {
        case .waitingForConfirmation:
            Button(L.text("pairing.cancel")) { model.cancelPairing() }
                .buttonStyle(CapsuleButtonStyle(.secondary, height: 56, fontSize: 17))
        case .submitting:
            Button {} label: { ProgressView() }
                .buttonStyle(CapsuleButtonStyle(.primary, height: 56, fontSize: 17))
                .disabled(true)
        default:
            Button {
                scanning = true
            } label: {
                HStack(spacing: 8) {
                    Icon(.scan, size: 22)
                    Text(L.text("pairing.scan"))
                }
            }
            .buttonStyle(CapsuleButtonStyle(.primary, height: 56, fontSize: 18))
        }
    }

    static func key(_ problem: PairingProblem) -> String {
        switch problem {
        case .unreadableCode: "unreadable"
        case .codeExpired: "expired"
        case .codeUsed: "used"
        case .codeInvalid: "invalid"
        case .unreachable: "unreachable"
        case .keysUnavailable: "keys"
        case .removed: "removed"
        }
    }
}

struct PairingScanner: View {
    let found: (String) -> Void
    let cancel: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            #if canImport(VisionKit) && os(iOS)
            if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                CodeScanner(found: found).ignoresSafeArea()
            } else {
                EmptyStateView(Text(L.text("pairing.cameraUnavailable")))
                    .himawariScreenBackground()
            }
            #else
            EmptyStateView(Text(L.text("pairing.cameraUnavailable")))
            #endif
            GlassCircleButton(Text(L.text("common.close")), action: cancel) {
                Icon(.x, size: 24)
            }
            .padding(16)
        }
    }
}

#if canImport(VisionKit) && os(iOS)
struct CodeScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(found: found)
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        if !controller.isScanning { try? controller.startScanning() }
    }

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let found: (String) -> Void
        private var delivered = false

        init(found: @escaping (String) -> Void) {
            self.found = found
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for item in addedItems {
                if case let .barcode(code) = item, let payload = code.payloadStringValue, payload.hasPrefix(PairingInvitation.scheme + ":") {
                    delivered = true
                    dataScanner.stopScanning()
                    found(payload)
                    return
                }
            }
        }
    }
}
#endif
