import HimawariCore
import HimawariDesign
import SwiftUI

enum SignInRoute: Hashable {
    case setupCode
}

public struct SignInView: View {
    let model: AppModel
    @State private var path: [SignInRoute]
    @State private var serverOpen: Bool
    @State private var confirmingStartOver = false
    private let quietAttempt: Bool
    private let typedCode: String

    public init(model: AppModel) {
        self.init(model: model, path: [], serverOpen: false, quietAttempt: true)
    }

    init(model: AppModel, path: [SignInRoute], serverOpen: Bool = false, quietAttempt: Bool, typedCode: String = "") {
        self.model = model
        self.typedCode = typedCode
        _path = State(initialValue: path)
        _serverOpen = State(initialValue: serverOpen)
        self.quietAttempt = quietAttempt
    }

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: SignInRoute.self) { _ in
                    SetupCodePage(model: model, code: typedCode)
                }
        }
        .sheet(isPresented: $serverOpen) {
            ServerSheet(model: model)
        }
        .task {
            guard quietAttempt else { return }
            await model.loadSignInInfo()
            await model.signInQuietly()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.signedOutProblem {
        case let problem? where problem == .keysUnreadable || problem == .storageUnavailable:
            ContentUnavailableView {
                Label(L.text("signIn.problem.\(Self.key(problem)).title"), systemImage: "exclamationmark.triangle")
            } description: {
                Text(L.text("signIn.problem.\(Self.key(problem))"))
            } actions: {
                Button(L.text("signIn.retry")) { model.retryReadingKeys() }
                    .buttonStyle(.borderedProminent)
                    .foregroundStyle(Color.hmOnText)
                Button(L.text("signIn.startOver"), role: .destructive) { confirmingStartOver = true }
            }
            .himawariScreenBackground()
            .confirmationDialog(L.text("signIn.startOver"), isPresented: $confirmingStartOver, titleVisibility: .visible) {
                Button(L.text("signIn.startOver"), role: .destructive) { model.startOver() }
            } message: {
                Text(Self.startOverWarning(unsent: model.unsentMessages))
            }
        default:
            welcome
        }
    }

    private var welcome: some View {
        GeometryReader { proxy in
            ScrollView {
                welcomeContent
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background { SignInGlow() }
        .animation(.easeInOut(duration: 0.25), value: model.phase)
    }

    private var welcomeContent: some View {
        VStack(spacing: DesignTokens.Pairing.homeGap) {
            if model.signedOutProblem == .removed {
                Text(L.text("signIn.removed"))
                    .font(.subheadline)
                    .foregroundStyle(Color.hmText)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(Color.hmSurface, in: RoundedRectangle(cornerRadius: DesignTokens.Pairing.bannerRadius, style: .continuous))
                    .hmShadow(DesignTokens.Shadows.lift)
            }
            Spacer(minLength: 0)
            SunflowerMark(growing: model.phase == .signingIn)
                .frame(width: DesignTokens.Size.pairingMark, height: DesignTokens.Size.pairingMark)
                .accessibilityHidden(true)
            VStack(spacing: DesignTokens.Size.rowGap) {
                Text(L.text("signIn.hello"))
                    .font(.largeTitle.bold())
                    .fontDesign(.rounded)
                    .foregroundStyle(Color.hmText)
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(L.text("signIn.subtitle"))
                    .font(.body)
                    .foregroundStyle(Color.hmMuted)
                    .multilineTextAlignment(.center)
            }
            Spacer(minLength: 0)
            buttons
        }
        .padding(.horizontal, DesignTokens.Pairing.paddingX)
        .padding(.bottom, DesignTokens.Size.rowGap)
    }

    private var buttons: some View {
        VStack(spacing: DesignTokens.Size.rowGap) {
            if let note = Self.welcomeNote(model.signedOutProblem) {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(Color.hmMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                Task { await model.signInWithPasskey() }
            } label: {
                Group {
                    if model.phase == .signingIn {
                        ProgressView()
                    } else {
                        Label(L.text("signIn.passkey"), systemImage: "person.badge.key")
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(Color.hmSun)
            .foregroundStyle(Color.hmOnText)
            .disabled(model.phase == .signingIn || model.serverOrigin == nil)
            Button {
                path.append(.setupCode)
            } label: {
                Text(L.text("signIn.firstTime"))
                    .foregroundStyle(Color.hmText)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(model.phase == .signingIn || model.serverOrigin == nil)
            Button {
                serverOpen = true
            } label: {
                Text(model.serverHost.map { L.format("signIn.server", $0) } ?? L.text("signIn.serverMissing"))
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: DesignTokens.Size.minTapTarget)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(Text(L.text("signIn.server.title")))
            .accessibilityValue(Text(model.serverHost ?? L.text("signIn.serverMissing")))
            .accessibilityHint(Text(L.text("signIn.server.hint")))
        }
    }

    static func welcomeNote(_ problem: SignInProblem?) -> String? {
        switch problem {
        case .noPasskeyHere?: L.text("signIn.problem.noPasskey")
        case .passkeyRejected?: L.text("signIn.problem.passkeyRejected")
        case .keysUnavailable?: L.text("signIn.problem.keys")
        case .tryAgain?: L.text("signIn.problem.tryAgain")
        case let .unreachable(code)?: SetupCodePage.unreachable(code: code, host: nil)
        default: nil
        }
    }

    static func key(_ problem: SignInProblem) -> String {
        problem == .keysUnreadable ? "keysUnreadable" : "storage"
    }

    static func startOverWarning(unsent: Int?) -> String {
        switch unsent {
        case 0?: L.text("signIn.startOver.confirm")
        case let count?: L.format("signIn.startOver.confirmUnsent", count)
        case nil: L.text("signIn.startOver.confirmUnknown")
        }
    }
}

struct SetupCodePage: View {
    let model: AppModel
    @State private var code: String
    @FocusState private var focused: Bool

    init(model: AppModel, code: String = "") {
        self.model = model
        _code = State(initialValue: code)
    }

    private var rule: SetupCodeRule? { model.signInInfo?.setupCode }
    private var busy: Bool { model.phase == .signingIn }
    private var ready: Bool { SetupCodeEntry.ready(code, rule: rule) && !busy }

    var body: some View {
        Form {
            Section {
                TextField(L.text("signIn.code.placeholder"), text: Binding(
                    get: { code },
                    set: { typed in
                        code = SetupCodeEntry.display(typed, rule: rule)
                        model.clearSetupProblem()
                    }
                ))
                .font(.body.monospaced())
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.characters)
                .textContentType(.oneTimeCode)
                #endif
                .focused($focused)
                .disabled(busy)
                .submitLabel(.continue)
                .onSubmit(submit)
                .accessibilityLabel(Text(L.text("signIn.code.title")))
            } footer: {
                VStack(alignment: .leading, spacing: DesignTokens.Size.rowGap) {
                    if let problem = model.setupProblem {
                        Text(Self.message(problem, host: model.serverHost))
                            .foregroundStyle(Color.hmDanger)
                        if case .unreachable = problem {
                            Button(L.text("signIn.retry"), action: submit)
                                .disabled(!ready)
                        }
                    }
                    Text(L.text("signIn.code.footer"))
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(L.text("signIn.code.title"))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if busy {
                    ProgressView()
                } else {
                    Button(L.text("signIn.code.continue"), action: submit)
                        .disabled(!ready)
                }
            }
        }
        .onAppear { focused = true }
        .task { if model.signInInfo == nil { await model.loadSignInInfo() } }
    }

    private func submit() {
        guard ready else { return }
        Task { await model.setUp(code: code) }
    }

    static func message(_ problem: SignInProblem, host: String?) -> String {
        switch problem {
        case .codeInvalid: L.text("signIn.code.invalid")
        case .codeExpired: L.text("signIn.code.expired")
        case let .tooManyAttempts(minutes?): L.format("signIn.code.tooManyMinutes", minutes)
        case .tooManyAttempts: L.text("signIn.code.tooMany")
        case .passkeyNeededAfterCode: L.text("signIn.code.passkeyNeeded")
        case .keysUnavailable: L.text("signIn.problem.keys")
        case .tryAgain, .noPasskeyHere, .passkeyRejected: L.text("signIn.problem.tryAgain")
        case let .unreachable(code): unreachable(code: code, host: host)
        case .keysUnreadable, .storageUnavailable, .removed: L.text("signIn.problem.tryAgain")
        }
    }

    static func unreachable(code: String?, host: String?) -> String {
        let base = host.map { L.format("signIn.unreachableHost", $0) } ?? L.text("signIn.unreachable")
        guard let code else { return base }
        return base + " (\(code))"
    }
}

struct ServerSheet: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var checking = false
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L.text("signIn.server.placeholder"), text: $address)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .textContentType(.URL)
                        #endif
                        .onChange(of: address) { failed = false }
                        .accessibilityLabel(Text(L.text("signIn.server.title")))
                } footer: {
                    VStack(alignment: .leading, spacing: DesignTokens.Size.rowGap) {
                        if failed {
                            Text(L.text("signIn.server.unreachable")).foregroundStyle(Color.hmDanger)
                        }
                        Text(L.text("signIn.server.footer"))
                    }
                }
                if !model.serverIsDefault {
                    Section {
                        Button(L.text("signIn.server.default")) {
                            model.useDefaultServer()
                            dismiss()
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(L.text("signIn.server.title"))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L.text("signIn.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if checking {
                        ProgressView()
                    } else {
                        Button(L.text("signIn.done"), action: save)
                            .disabled(ServerOrigin.parse(address) == nil)
                    }
                }
            }
        }
        .onAppear { address = model.serverOrigin?.absoluteString ?? "" }
    }

    private func save() {
        checking = true
        Task {
            let reached = await model.useServer(address)
            checking = false
            if reached { dismiss() } else { failed = true }
        }
    }
}

struct SignInGlow: View {
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
