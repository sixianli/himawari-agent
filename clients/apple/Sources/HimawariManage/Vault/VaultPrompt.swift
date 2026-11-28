#if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)
import HimawariCore
import HimawariDesign
import SwiftUI

struct VaultCodeSheet: View {
    let request: VaultCodeRequest
    let transport: any VaultCodeTransport
    let done: () -> Void
    @State private var typed = ""
    @State private var busy = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    private var code: String? { VaultCode.cleaned(typed) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(request.purpose)
                    TextField(M.vaultCodeField, text: $typed)
                        #if os(iOS)
                        .textContentType(.oneTimeCode)
                        .textInputAutocapitalization(.never)
                        #endif
                        .autocorrectionDisabled()
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(send)
                } footer: {
                    Text(M.vaultCodeSite(VaultAssembly.host(request.origin)))
                }
                if let failure {
                    Section {
                        Text(failure).foregroundStyle(Color.hmDanger)
                    }
                }
            }
            .navigationTitle(M.vaultCodeTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(M.vaultCodeDecline, action: decline).disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(M.vaultCodeSend, action: send).disabled(code == nil || busy)
                }
            }
        }
        .onAppear { focused = true }
        .interactiveDismissDisabled(busy)
    }

    private func send() {
        guard let code else {
            failure = typed.isEmpty ? nil : M.vaultCodeInvalid
            return
        }
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                switch try await transport.answerVaultCode(requestId: request.id, code: code) {
                case .recorded: done()
                case .gone: failure = M.vaultCodeGone
                }
            } catch {
                failure = M.vaultSaveFailed
            }
        }
    }

    private func decline() {
        busy = true
        Task {
            defer { busy = false }
            _ = try? await transport.declineVaultCode(requestId: request.id)
            done()
        }
    }
}

struct VaultApprovalLink: Identifiable, Equatable {
    let id: String
}

public struct VaultPrompt: ViewModifier {
    private let api: DeviceAPI
    private let confirmKey: DeviceKeySigner
    private let requested: Bool
    private let handled: () -> Void
    @State private var approval: VaultApprovalLink?
    @State private var code: VaultCodeRequest?
    @State private var closed: Set<String> = []
    @Environment(\.scenePhase) private var scenePhase

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, requested: Bool, handled: @escaping () -> Void) {
        self.api = api
        self.confirmKey = confirmKey
        self.requested = requested
        self.handled = handled
    }

    public func body(content: Content) -> some View {
        content
            .task { await refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await refresh() } }
            }
            .onChange(of: requested, initial: true) { _, now in
                guard now else { return }
                handled()
                closed.removeAll()
                Task { await refresh() }
            }
            .sheet(item: $approval) { link in
                VaultApprovalView(api: api, confirmKey: confirmKey, requestId: link.id) {
                    closed.insert(link.id)
                    approval = nil
                    Task { await refresh() }
                }
                .presentationDetents([.large])
            }
            .sheet(item: $code) { request in
                VaultCodeSheet(request: request, transport: api) {
                    closed.insert(request.id)
                    code = nil
                    Task { await refresh() }
                }
                .presentationDetents([.medium, .large])
            }
    }

    private func live(_ id: String, _ expiresAt: String) -> Bool {
        !closed.contains(id) && (Timestamp.parse(expiresAt).map { $0 > Date() } ?? true)
    }

    private func refresh() async {
        guard approval == nil, code == nil else { return }
        if let pending = try? await api.vaultSnapshot().pending.first(where: { live($0.id, $0.expiresAt) }) {
            approval = VaultApprovalLink(id: pending.id)
            return
        }
        if let request = try? await api.vaultCodeRequests().first(where: { live($0.id, $0.expiresAt) }) {
            code = request
        }
    }
}

extension View {
    public func vaultPrompt(api: DeviceAPI, confirmKey: DeviceKeySigner, requested: Bool, handled: @escaping () -> Void) -> some View {
        modifier(VaultPrompt(api: api, confirmKey: confirmKey, requested: requested, handled: handled))
    }
}

public struct VaultOTPAuthImport: Identifiable, Equatable {
    public let id = UUID()
    let prefill: VaultFormPrefill

    public init?(url: URL) {
        guard url.scheme?.lowercased() == "otpauth", let prefill = VaultFormPrefill(otpauth: url.absoluteString) else { return nil }
        self.prefill = prefill
    }
}

public struct VaultOTPAuthImportView: View {
    @State private var model: VaultModel
    private let link: VaultOTPAuthImport
    private let close: () -> Void

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, link: VaultOTPAuthImport, close: @escaping () -> Void) {
        _model = State(initialValue: VaultAssembly.model(api: api, confirmKey: confirmKey))
        self.link = link
        self.close = close
    }

    public var body: some View {
        NavigationStack {
            VaultFormPage(model: model, prefill: link.prefill, done: close, back: close)
        }
        .task { await model.load() }
    }
}
#endif
