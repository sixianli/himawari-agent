import HimawariCore
import HimawariDesign
import SwiftUI

struct PairingView: View {
    let model: AppModel
    @State private var scanning: Bool
    @State private var confirmingStartOver = false
    @State private var startOverWarning = ""

    init(model: AppModel, scanning: Bool = false) {
        self.model = model
        _scanning = State(initialValue: scanning)
    }

    var body: some View {
        content
            .padding(.horizontal, DesignTokens.Pairing.paddingX)
            .padding(.bottom, DesignTokens.Pairing.paddingBottom)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background { PairingGlow() }
            .animation(.easeInOut(duration: 0.25), value: model.phase)
            .confirmationDialog(startOverWarning, isPresented: $confirmingStartOver, titleVisibility: .visible) {
                Button(L.text("pairing.startOver"), role: .destructive) { model.startOver() }
                Button(L.text("pairing.cancel"), role: .cancel) {}
            }
            .hmCover(isPresented: $scanning) {
                PairingScanner { text in
                    scanning = false
                    model.pair(scanned: text)
                } cancel: {
                    scanning = false
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case let .confirmingServer(host):
            confirmServer(host)
        case let .waitingForConfirmation(number):
            waiting(number)
        case let .unpaired(problem?) where problem == .keysUnreadable || problem == .storageUnavailable || problem == .stateUnknown:
            problemPage(icon: .alertCircleLarge, tint: .hmMuted, problem: problem) {
                VStack(spacing: 6) {
                    Button(L.text("pairing.retry")) { model.retryReadingKeys() }
                        .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
                    linkButton(L.text("pairing.startOver")) {
                        startOverWarning = Self.startOverWarningText(unsent: model.unsentMessages)
                        confirmingStartOver = true
                    }
                }
            }
        case let .unpaired(problem?) where problem == .unreachable:
            problemPage(icon: .serverLarge, tint: .hmMuted, problem: problem) {
                VStack(spacing: 6) {
                    Button(L.text("pairing.retry")) { model.retryPairing() }
                        .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
                    linkButton(L.text("pairing.cancel")) { model.cancelPairing() }
                }
            }
        case let .unpaired(problem?) where problem != .removed:
            problemPage(icon: .alertCircleLarge, tint: .hmDanger, problem: problem) {
                scanButton(L.text("pairing.rescan"))
            }
        case let .unpaired(problem):
            home(removed: problem == .removed)
        case .submitting:
            home(removed: false)
        case .active:
            EmptyView()
        }
    }

    private func home(removed: Bool) -> some View {
        VStack(spacing: 0) {
            VStack(spacing: DesignTokens.Pairing.homeGap) {
                if removed {
                    Text(L.text("pairing.problem.removed"))
                        .hmType(DesignTokens.TypeScale.secondary)
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.center)
                        .padding(.vertical, 12)
                        .padding(.horizontal, 18)
                        .frame(maxWidth: .infinity)
                        .background(Color.hmSurface, in: RoundedRectangle(cornerRadius: DesignTokens.Pairing.bannerRadius, style: .continuous))
                        .hmShadow(DesignTokens.Shadows.lift)
                        .padding(.bottom, -7)
                }
                SunflowerMark(growing: model.phase == .submitting)
                    .frame(width: DesignTokens.Size.pairingMark, height: DesignTokens.Size.pairingMark)
                VStack(spacing: 10) {
                    Text(L.text("pairing.hello"))
                        .font(.system(size: removed ? DesignTokens.Pairing.removedTitleSize : DesignTokens.TypeScale.title1.size, weight: .bold, design: .rounded))
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.center)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .offset(y: removed ? -4 : -3)
                    Text(L.text("pairing.subtitle"))
                        .font(DesignTokens.TypeScale.body.font)
                        .hmLineHeight(DesignTokens.TypeScale.body.size * 1.5)
                        .foregroundStyle(Color.hmMuted)
                        .multilineTextAlignment(.center)
                }
                if !removed {
                    steps
                }
            }
            .padding(.top, removed ? DesignTokens.Pairing.removedBannerTop : DesignTokens.Pairing.homeTop)
            Spacer(minLength: 24)
            if model.phase == .submitting {
                Button {} label: { ProgressView().tint(Color.hmOnText) }
                    .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
                    .disabled(true)
            } else {
                scanButton(L.text("pairing.scan"))
            }
        }
    }

    private var steps: some View {
        VStack(spacing: 0) {
            ForEach(1...3, id: \.self) { index in
                HStack(spacing: DesignTokens.Size.rowGap) {
                    Text(index, format: .number)
                        .font(.rounded(DesignTokens.TypeScale.body.size, weight: .bold))
                        .foregroundStyle(Color.hmSun)
                        .frame(width: DesignTokens.Pairing.stepNumberWidth, alignment: .leading)
                    Text(L.text("pairing.step\(index)"))
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: DesignTokens.Pairing.stepRowHeight)
                if index < 3 { RowSeparator() }
            }
        }
        .padding(.horizontal, 18)
        .background(Color.hmSurface, in: RoundedRectangle(cornerRadius: DesignTokens.Pairing.stepCardRadius, style: .continuous))
        .hmShadow(DesignTokens.Shadows.lift)
    }

    private func confirmServer(_ host: String) -> some View {
        VStack(spacing: 0) {
            VStack(spacing: 30) {
                SunflowerMark()
                    .frame(width: DesignTokens.Pairing.waitingMark, height: DesignTokens.Pairing.waitingMark)
                VStack(spacing: 12) {
                    Text(host)
                        .font(.system(size: DesignTokens.TypeScale.title1.size, weight: .bold))
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.center)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                    Text(L.text("pairing.serverCaption"))
                        .hmType(DesignTokens.TypeScale.secondary)
                        .foregroundStyle(Color.hmMuted)
                }
            }
            .padding(.top, DesignTokens.Pairing.waitingTop)
            Spacer(minLength: 24)
            HStack(spacing: 12) {
                Button(L.text("pairing.cancel")) {
                    model.declineScannedServer()
                    scanning = true
                }
                .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
                Button(L.text("pairing.connect")) { model.connectToScannedServer() }
                    .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
            }
        }
    }

    private func waiting(_ number: String) -> some View {
        VStack(spacing: 0) {
            VStack(spacing: 30) {
                SunflowerMark(growing: true)
                    .frame(width: DesignTokens.Pairing.waitingMark, height: DesignTokens.Pairing.waitingMark)
                VStack(spacing: 15) {
                    Text(number)
                        .hmType(DesignTokens.TypeScale.pairingNumber)
                        .monospacedDigit()
                        .foregroundStyle(Color.hmText)
                        .accessibilityLabel(Text(number.replacingOccurrences(of: " ", with: "")))
                    Text(L.text("pairing.waiting"))
                        .font(.himawari(DesignTokens.Pairing.waitingTextSize, weight: .semibold))
                        .hmLineHeight(DesignTokens.Pairing.waitingTextSize * 1.5)
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.center)
                }
                Text(L.format("pairing.waitingServer", model.serverHost ?? ""))
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
            }
            .padding(.top, DesignTokens.Pairing.waitingTop)
            Spacer(minLength: 24)
            linkButton(L.text("pairing.cancel")) { model.cancelPairing() }
        }
    }

    private func problemPage<Actions: View>(icon: IconName, tint: Color, problem: PairingProblem, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(spacing: 0) {
            VStack(spacing: 22) {
                Icon(icon, size: DesignTokens.Pairing.errorIcon)
                    .foregroundStyle(tint)
                Text(L.text("pairing.problem.\(Self.key(problem)).title"))
                    .font(.himawari(DesignTokens.Pairing.errorTitleSize, weight: .semibold))
                    .foregroundStyle(Color.hmText)
                    .multilineTextAlignment(.center)
                Text(Self.detail(problem))
                    .font(DesignTokens.TypeScale.body.font)
                    .hmLineHeight(DesignTokens.TypeScale.body.size * 1.5)
                    .foregroundStyle(Color.hmMuted)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, DesignTokens.Pairing.errorTop)
            Spacer(minLength: 24)
            actions()
        }
    }

    private func scanButton(_ title: String) -> some View {
        Button {
            model.dismissProblem()
            scanning = true
        } label: {
            HStack(spacing: 10) {
                Icon(.scan, size: DesignTokens.IconSize.glassButton)
                Text(title)
            }
        }
        .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
    }

    private func linkButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .hmType(DesignTokens.TypeScale.body)
            .foregroundStyle(Color.hmSun)
            .frame(minHeight: DesignTokens.Size.minTapTarget)
            .buttonStyle(.pressable)
    }

    static func detail(_ problem: PairingProblem) -> String {
        let plain = L.text("pairing.problem.\(key(problem))")
        guard case let .codeExpired(ttl?) = problem else { return plain }
        let limit = ttl % 60 == 0
            ? L.format("pairing.problem.expired.ttlMinutes", ttl / 60)
            : L.format("pairing.problem.expired.ttlSeconds", ttl)
        return limit + plain
    }

    private static func startOverWarningText(unsent: Int?) -> String {
        switch unsent {
        case 0?: L.text("pairing.startOver.confirm")
        case let count?: L.format("pairing.startOver.confirmUnsent", count)
        case nil: L.text("pairing.startOver.confirmUnknown")
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
        case .keysUnreadable: "keysUnreadable"
        case .storageUnavailable: "storage"
        case .stateUnknown: "stateUnknown"
        case .removed: "removed"
        }
    }
}

struct PairingGlow: View {
    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.hmBackground
                RadialGradient(
                    colors: [Color.hmGlow, .clear],
                    center: UnitPoint(x: 0.5, y: DesignTokens.Pairing.glowCenterY / max(proxy.size.height, 1)),
                    startRadius: 0,
                    endRadius: DesignTokens.Pairing.glowRadius
                )
            }
        }
        .ignoresSafeArea()
    }
}

struct PairingScanner: View {
    let found: (String) -> Void
    let cancel: () -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            #if DEBUG
            if DemoScene.requested != nil {
                CameraStandIn()
                ScannerFrame(caption: Text(L.text("pairing.aim")))
            } else {
                camera
            }
            #else
            camera
            #endif
            ScannerCloseButton(Text(L.text("common.close")), action: cancel)
                .padding(.leading, DesignTokens.Size.pagePaddingX)
                .frame(height: DesignTokens.Size.navBarHeight)
        }
    }

    @ViewBuilder
    private var camera: some View {
        Group {
            #if canImport(VisionKit) && os(iOS)
            if QRCodeScanner.available {
                QRCodeScanner(accepts: { $0.hasPrefix(PairingInvitation.scheme + ":") }, found: found).ignoresSafeArea()
                ScannerFrame(caption: Text(L.text("pairing.aim")))
            } else {
                EmptyStateView(Text(L.text("pairing.cameraUnavailable")))
                    .himawariScreenBackground()
            }
            #else
            EmptyStateView(Text(L.text("pairing.cameraUnavailable")))
            #endif
        }
    }
}
