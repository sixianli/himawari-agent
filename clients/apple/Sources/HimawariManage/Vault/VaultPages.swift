#if canImport(CryptoKit) && canImport(Security) && canImport(LocalAuthentication)
import HimawariCore
import HimawariDesign
import SwiftUI

typealias VL = ManageLayout.VaultSheet

@MainActor
enum VaultAssembly {
    static func model(api: DeviceAPI, confirmKey: DeviceKeySigner) -> VaultModel {
        let deviceId = api.http.currentCredentials?.deviceId ?? ""
        let session = VaultSession(
            transport: DeviceVaultTransport(api: api, confirmKey: confirmKey),
            keys: VaultKeychainMasterKeyStore(accessGroup: SharedVault(bundle: .main).keychainGroup),
            floor: DefaultsVaultManifestFloor(deviceId: deviceId),
            deviceId: deviceId
        )
        return VaultModel(session: session)
    }

    static func host(_ origin: String) -> String {
        origin.hasPrefix("https://") ? String(origin.dropFirst("https://".count)) : origin
    }

    static func declined(_ error: Error) -> Bool {
        !(error is VaultSessionError || error is DeviceAPIError || error is VaultMasterKeyError || error is VaultCryptoError || error is DecodingError || error is URLError || error is HTTPExchangeError)
    }

    static func message(_ error: Error) -> String? {
        switch error {
        case VaultSessionError.conflict: M.vaultConflict
        case VaultSessionError.requestGone: M.vaultRequestGone
        case VaultSessionError.requestMismatch: M.vaultRequestMismatch
        case VaultSessionError.manifestInvalid, VaultSessionError.manifestRolledBack: M.vaultManifestInvalid
        case VaultSessionError.keyMissing: M.vaultKeyMissing
        case _ where declined(error): nil
        default: M.vaultSaveFailed
        }
    }
}

public struct VaultRootView: View {
    enum Page: Hashable {
        case add
        case manual
        case item(String)
        case replace(String, VaultItemField)
        case security
    }

    @State private var model: VaultModel
    @State private var settings: SettingsStore
    @State private var path: [Page] = []
    private let close: () -> Void

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, close: @escaping () -> Void) {
        _model = State(initialValue: VaultAssembly.model(api: api, confirmKey: confirmKey))
        _settings = State(initialValue: SettingsStore(directory: SignedDeviceDirectory(http: api.http, confirmKey: confirmKey)))
        self.close = close
    }

    public var body: some View {
        NavigationStack(path: $path) {
            VaultListPage(model: model, open: { path.append(.item($0)) }, add: { path.append(.add) }, security: { path.append(.security) }, close: close)
                .navigationDestination(for: Page.self) { page in
                    switch page {
                    case .add:
                        VaultAddPage(manual: { path.append(.manual) }, back: pop)
                    case .manual:
                        VaultFormPage(model: model, done: { path = [] }, back: pop)
                    case .item(let id):
                        VaultItemPage(model: model, itemId: id, replace: { path.append(.replace(id, $0)) }, deleted: { path = [] }, back: pop)
                    case .replace(let id, let field):
                        VaultReplacePage(model: model, itemId: id, field: field, back: pop)
                    case .security:
                        VaultSecurityPage(model: model, settings: settings, back: pop)
                    }
                }
        }
        .task { await model.load() }
    }

    private func pop() {
        if !path.isEmpty { path.removeLast() }
    }
}

struct VaultListPage: View {
    let model: VaultModel
    let open: (String) -> Void
    let add: () -> Void
    let security: () -> Void
    let close: () -> Void

    var body: some View {
        SettingsPage(gap: VL.gap, systemBar: false) {
            SheetHeader(title: M.vaultTitle, leading: .close, action: close)
            VaultNote(M.vaultIntro)
            switch model.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity)
            case .keyMissing:
                VaultNote(M.vaultKeyMissing)
            case .manifestInvalid:
                VaultNote(M.vaultManifestInvalid, tone: .danger)
            case .failed:
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            case .ready:
                if model.items.isEmpty {
                    VaultNote(M.vaultEmpty)
                } else {
                    SettingsGroup(label: nil) {
                        ForEach(Array(model.items.enumerated()), id: \.element.id) { index, item in
                            Button { open(item.id) } label: {
                                SettingsRow(
                                    icon: item.kind == .apiKey ? .key : .lock,
                                    title: item.name,
                                    detail: M.vaultUsedLine(item.origins.map(VaultAssembly.host).joined(separator: " · "), lastUse(item.id)),
                                    chevron: true,
                                    last: index == model.items.count - 1
                                )
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                }
                Button(action: add) {
                    HStack(spacing: VL.buttonGap) {
                        Icon(.plus, size: DesignTokens.IconSize.listRow)
                        Text(M.vaultAdd)
                    }
                }
                .buttonStyle(CapsuleButtonStyle(.secondary, height: VL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
            }
            if model.phase != .loading && model.phase != .failed {
                SettingsGroup(label: nil) {
                    Button(action: security) {
                        SettingsRow(icon: .shieldLock, title: M.vaultSecurityTitle, detail: M.vaultSecuritySubtitle, chevron: true, last: true)
                    }
                    .buttonStyle(.pressable)
                }
            }
        }
        .refreshable { await model.load() }
    }

    private func lastUse(_ itemId: String) -> String? {
        model.lastUse[itemId].flatMap(Timestamp.parse).map { M.dayAndTime($0, now: Date(), calendar: .current) }
    }
}

struct VaultNote: View {
    enum Tone {
        case muted
        case danger
    }

    let text: String
    let tone: Tone

    init(_ text: String, tone: Tone = .muted) {
        self.text = text
        self.tone = tone
    }

    var body: some View {
        Text(text)
            .hmType(VL.note)
            .foregroundStyle(tone == .danger ? Color.hmDanger : Color.hmMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, SL.groupLabelPadding)
    }
}

struct VaultAddPage: View {
    let manual: () -> Void
    let back: () -> Void

    var body: some View {
        SettingsPage(gap: VL.gap) {
            SheetHeader(title: M.vaultAdd, leading: .back, action: back)
            SettingsGroup(label: nil) {
                Button(action: manual) {
                    SettingsRow(icon: .pencil, title: M.vaultManual, detail: M.vaultManualSubtitle, chevron: true, last: true)
                }
                .buttonStyle(.pressable)
            }
            VaultNote(M.vaultAddLater)
            VaultNote(M.vaultEncryptedHere)
        }
    }
}

struct VaultFieldRow<Field: View>: View {
    let label: String
    var note: String? = nil
    var noteIsWarning = false
    var last = false
    @ViewBuilder let field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: SL.rowTextGap) {
            Text(label).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
            field
                .hmType(SL.rowValue)
                .foregroundStyle(Color.hmText)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            if let note {
                Text(note).hmType(DesignTokens.TypeScale.caption).foregroundStyle(noteIsWarning ? Color.hmDanger : Color.hmMuted)
            }
        }
        .padding(.vertical, SL.rowPaddingVertical)
        .frame(minHeight: VL.fieldMinHeight, alignment: .leading)
        .overlay(alignment: .bottom) { if !last { RowSeparator() } }
    }
}

struct VaultSecretField: View {
    let label: String
    @Binding var value: String
    var scannable = false
    var last = false
    @State private var scanning = false

    var body: some View {
        VaultFieldRow(label: label, last: last) {
            HStack(spacing: VL.buttonGap) {
                SecureField("", text: $value)
                    #if os(iOS)
                    .textContentType(.oneTimeCode)
                    #endif
                if scannable && QRCodeScannerAvailability.available {
                    Button { scanning = true } label: {
                        Icon(.scan, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmSun)
                    }
                    .buttonStyle(.pressable)
                    .accessibilityLabel(Text(M.vaultScan))
                }
            }
        }
        #if canImport(VisionKit) && os(iOS)
        .fullScreenCover(isPresented: $scanning) {
            ZStack(alignment: .topLeading) {
                QRCodeScanner(accepts: { VaultOTPAuth.seed(from: $0) != nil }, found: { scanned in
                    value = VaultOTPAuth.seed(from: scanned) ?? ""
                    scanning = false
                })
                .ignoresSafeArea()
                ScannerFrame(caption: Text(M.vaultScanAim))
                ScannerCloseButton(Text(M.close)) { scanning = false }
                    .padding(.leading, DesignTokens.Size.pagePaddingX)
                    .frame(height: DesignTokens.Size.navBarHeight)
            }
        }
        #endif
    }
}

enum QRCodeScannerAvailability {
    @MainActor static var available: Bool {
        #if canImport(VisionKit) && os(iOS)
        QRCodeScanner.available
        #else
        false
        #endif
    }
}

struct VaultFormPage: View {
    let model: VaultModel
    let done: () -> Void
    let back: () -> Void
    @State private var kind: VaultItemKind = .login
    @State private var name = ""
    @State private var site = ""
    @State private var username = ""
    @State private var secret = ""
    @State private var totp = ""
    @State private var busy = false
    @State private var failure: String?

    private var origin: String? { VaultContract.origin(site.trimmingCharacters(in: .whitespacesAndNewlines)) }
    private var totpValid: Bool { totp.isEmpty || VaultTOTP.base32Decode(totp).map { !$0.isEmpty } == true }
    private var valid: Bool { VaultContract.name(name) != nil && origin != nil && !secret.isEmpty && totpValid }

    var body: some View {
        SettingsPage(gap: VL.formGap) {
            SheetHeader(title: M.vaultManual, leading: .back, action: back)
            Picker("", selection: $kind) {
                Text(M.vaultKindLogin).tag(VaultItemKind.login)
                Text(M.vaultKindKey).tag(VaultItemKind.apiKey)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            SettingsGroup(label: nil) {
                VaultFieldRow(label: M.vaultName) { TextField("", text: $name) }
                VaultFieldRow(label: M.vaultSite, note: siteNote, noteIsWarning: origin == nil && !site.isEmpty) {
                    TextField(M.vaultSitePlaceholder, text: $site)
                        #if os(iOS)
                        .keyboardType(.URL)
                        #endif
                }
                if kind == .login {
                    VaultFieldRow(label: M.vaultUsername) {
                        TextField("", text: $username)
                            #if os(iOS)
                            .textContentType(.username)
                            #endif
                    }
                    VaultSecretField(label: M.vaultPassword, value: $secret)
                    VaultSecretField(label: M.vaultTOTP, value: $totp, scannable: true, last: true)
                } else {
                    VaultSecretField(label: M.vaultKey, value: $secret, last: true)
                }
            }
            if !totpValid { VaultNote(M.vaultTOTPInvalid, tone: .danger) }
            if let failure { VaultNote(failure, tone: .danger) }
            Spacer(minLength: VL.formGap)
            Button(action: save) { Text(M.vaultSave) }
                .buttonStyle(CapsuleButtonStyle(.primary, height: VL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                .disabled(!valid || busy)
        }
    }

    private var siteNote: String? {
        if let origin { return M.vaultSiteSaved(origin) }
        return site.isEmpty ? nil : M.vaultSiteInvalid
    }

    private func save() {
        guard let origin else { return }
        var values: [String: String] = [:]
        if kind == .login {
            values["password"] = secret
            if !username.isEmpty { values["username"] = username }
            if !totp.isEmpty { values["totp"] = totp.replacingOccurrences(of: " ", with: "").uppercased() }
        } else {
            values["api_key"] = secret
        }
        let item = VaultItemValues(name: name, kind: kind, origins: [origin], values: values, backgroundAllowed: false)
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                try await model.add(item)
                secret = ""
                totp = ""
                done()
            } catch {
                failure = VaultAssembly.message(error)
            }
        }
    }
}

struct VaultItemPage: View {
    let model: VaultModel
    let itemId: String
    let replace: (VaultItemField) -> Void
    let deleted: () -> Void
    let back: () -> Void
    @State private var confirmingDelete = false
    @State private var failure: String?

    var body: some View {
        SettingsPage(gap: VL.gap) {
            if let item = model.item(itemId) {
                SheetHeader(title: item.name, leading: .back, action: back)
                SettingsGroup(label: nil) {
                    SettingsRow(icon: nil, title: M.vaultSiteRow, detail: item.origins.joined(separator: "\n"))
                    if let username = model.usernames[item.id] {
                        SettingsRow(icon: nil, title: M.vaultUsername, detail: username)
                    }
                    hiddenRow(item.kind == .apiKey ? M.vaultKey : M.vaultPassword, field: .secret, last: !item.fields.contains("totp"))
                    if item.fields.contains("totp") {
                        hiddenRow(M.vaultTOTPShort, field: .totp, last: true)
                    }
                }
                SettingsGroup(label: M.vaultUsageTitle) {
                    let entries = model.usage[item.id] ?? []
                    if entries.isEmpty {
                        SettingsRow(icon: nil, title: M.vaultUsageEmpty, last: true)
                    } else {
                        ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                            SettingsRow(icon: nil, title: entry.purpose ?? VaultAssembly.host(entry.origin), detail: usageLine(entry), last: index == entries.count - 1)
                        }
                    }
                }
                if let failure { VaultNote(failure, tone: .danger) }
                Button(role: .destructive) { confirmingDelete = true } label: {
                    Text(M.vaultDelete).foregroundStyle(Color.hmDanger)
                }
                .buttonStyle(CapsuleButtonStyle(.secondary, height: VL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                .confirmationDialog(M.vaultDelete, isPresented: $confirmingDelete, titleVisibility: .visible) {
                    Button(M.vaultDelete, role: .destructive) { delete() }
                }
            } else {
                SheetHeader(title: M.vaultTitle, leading: .back, action: back)
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await model.loadUsage(itemId) }
    }

    private func hiddenRow(_ title: String, field: VaultItemField, last: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                VStack(alignment: .leading, spacing: SL.rowTextGap) {
                    Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    Text(M.vaultStoredHidden).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button { replace(field) } label: {
                    Text(M.vaultReplace).hmType(DesignTokens.TypeScale.rowAction).foregroundStyle(Color.hmSun)
                }
                .buttonStyle(.pressable)
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if !last { RowSeparator() }
        }
    }

    private func usageLine(_ entry: VaultUsageEntry) -> String {
        let when = Timestamp.parse(entry.at).map { M.dayAndTime($0, now: Date(), calendar: .current) } ?? ""
        return "\(when) · \(M.vaultUsageOutcome(entry.outcome))"
    }

    private func delete() {
        failure = nil
        Task {
            do {
                try await model.delete(itemId)
                deleted()
            } catch {
                failure = VaultAssembly.message(error)
            }
        }
    }
}

struct VaultReplacePage: View {
    let model: VaultModel
    let itemId: String
    let field: VaultItemField
    let back: () -> Void
    @State private var value = ""
    @State private var busy = false
    @State private var failure: String?

    private var label: String {
        switch field {
        case .secret: model.item(itemId)?.kind == .apiKey ? M.vaultKey : M.vaultPassword
        case .username: M.vaultUsername
        case .totp: M.vaultTOTPShort
        }
    }

    private var valid: Bool {
        guard !value.isEmpty else { return false }
        return field != .totp || VaultTOTP.base32Decode(value).map { !$0.isEmpty } == true
    }

    var body: some View {
        SettingsPage(gap: VL.formGap) {
            SheetHeader(title: M.vaultReplace, leading: .back, action: back)
            SettingsGroup(label: nil) {
                VaultSecretField(label: label, value: $value, scannable: field == .totp, last: true)
            }
            if let failure { VaultNote(failure, tone: .danger) }
            Spacer(minLength: VL.formGap)
            Button(action: save) { Text(M.vaultReplaceWith) }
                .buttonStyle(CapsuleButtonStyle(.primary, height: VL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                .disabled(!valid || busy)
        }
    }

    private func save() {
        busy = true
        failure = nil
        let replacement = field == .totp ? value.replacingOccurrences(of: " ", with: "").uppercased() : value
        Task {
            defer { busy = false }
            do {
                try await model.replace(itemId, field: field, with: replacement)
                value = ""
                back()
            } catch {
                failure = VaultAssembly.message(error)
            }
        }
    }
}

struct VaultSecurityPage: View {
    let model: VaultModel
    let settings: SettingsStore
    let back: () -> Void
    @State private var revoking: PairedDevice?
    @State private var confirmingRotate = false
    @State private var busy = false
    @State private var note: String?

    private var phones: [PairedDevice] { settings.devices.filter { $0.kind == "iphone" } }

    var body: some View {
        SettingsPage(gap: VL.gap) {
            SheetHeader(title: M.vaultSecurityTitle, leading: .back, action: back)
            SettingsGroup(label: M.vaultPhonesGroup) {
                ForEach(Array(phones.enumerated()), id: \.element.id) { index, device in
                    HStack(spacing: SL.rowGap) {
                        SettingsRow(
                            icon: .deviceMobile,
                            title: device.name,
                            detail: settings.isThisDevice(device) ? M.vaultThisPhone : M.presence(settings.presence(device)),
                            last: true
                        )
                        if !settings.isThisDevice(device) {
                            Button { revoking = device } label: {
                                Text(M.vaultRevoke).hmType(DesignTokens.TypeScale.rowAction).foregroundStyle(Color.hmDanger)
                            }
                            .buttonStyle(.pressable)
                        }
                    }
                    .overlay(alignment: .bottom) { if index < phones.count - 1 { RowSeparator() } }
                }
            }
            VaultNote(M.vaultRevokeNote)
            SettingsGroup(label: nil) {
                Button { confirmingRotate = true } label: {
                    SettingsRow(icon: .refresh, title: M.vaultRotate, detail: M.vaultRotateSubtitle, chevron: true, last: true)
                }
                .buttonStyle(.pressable)
                .disabled(busy || model.phase != .ready)
            }
            if let note { VaultNote(note, tone: note == M.vaultRotateDone ? .muted : .danger) }
            VaultNote(M.vaultKeyLocation)
        }
        .task { await settings.load() }
        .confirmationDialog(M.vaultRotate, isPresented: $confirmingRotate, titleVisibility: .visible) {
            Button(M.vaultRotate, role: .destructive) { rotate() }
        } message: {
            Text(M.vaultRotateSubtitle)
        }
        .confirmationDialog(M.vaultRevoke, isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), titleVisibility: .visible) {
            if let device = revoking {
                Button(M.vaultRevokeReason(device.name), role: .destructive) { revoke(device) }
            }
        }
    }

    private func rotate() {
        busy = true
        note = nil
        Task {
            defer { busy = false }
            do {
                try await model.rotate()
                note = M.vaultRotateDone
            } catch {
                note = VaultAssembly.message(error)
            }
        }
    }

    private func revoke(_ device: PairedDevice) {
        revoking = nil
        Task {
            do {
                try await settings.revoke(device, reason: M.vaultRevokeReason(device.name))
            } catch {
                note = M.vaultSaveFailed
            }
        }
    }
}

public struct VaultApprovalView: View {
    @State private var model: VaultModel
    private let requestId: String
    private let close: () -> Void
    @State private var busy = false
    @State private var failure: String?

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, requestId: String, close: @escaping () -> Void) {
        _model = State(initialValue: VaultAssembly.model(api: api, confirmKey: confirmKey))
        self.requestId = requestId
        self.close = close
    }

    public var body: some View {
        SettingsPage(gap: VL.gap, systemBar: false) {
            SheetHeader(title: M.vaultApproveTitle, leading: .close, action: close)
            switch model.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity)
            case .keyMissing:
                VaultNote(M.vaultKeyMissing)
            case .manifestInvalid:
                VaultNote(M.vaultManifestInvalid, tone: .danger)
            case .failed:
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            case .ready:
                if let request = model.request(requestId) {
                    approval(request)
                } else {
                    VaultNote(M.vaultRequestGone)
                }
            }
            if let failure { VaultNote(failure, tone: .danger) }
        }
        .task { await model.load() }
    }

    @ViewBuilder
    private func approval(_ request: VaultPendingRequest) -> some View {
        let items = request.itemIds.compactMap(model.item)
        VStack(alignment: .leading, spacing: VL.formGap) {
            ForEach(items, id: \.id) { item in
                HStack(spacing: VL.buttonGap) {
                    Icon(item.kind == .apiKey ? .key : .lock, size: VL.tileIcon)
                        .foregroundStyle(Color.hmText)
                        .frame(width: VL.tile, height: VL.tile)
                        .background(Color.hmFill, in: RoundedRectangle(cornerRadius: VL.tileRadius))
                    VStack(alignment: .leading, spacing: SL.rowTextGap) {
                        Text(item.name).hmType(VL.itemTitle).foregroundStyle(Color.hmText)
                        Text(M.vaultOnlyFor(request.origin)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    }
                }
            }
            HStack(spacing: SL.rowTextGap) {
                Icon(.check, size: DesignTokens.IconSize.chevron).foregroundStyle(Color.hmSuccess)
                Text(M.vaultMatches).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
            }
            RowSeparator()
            VStack(alignment: .leading, spacing: SL.rowTextGap) {
                Text(M.vaultPurposeLabel).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                Text(request.purpose).hmType(SL.rowValue).foregroundStyle(Color.hmText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard()
        VaultNote(M.vaultApproveFooter)
        Spacer(minLength: VL.gap)
        HStack(spacing: VL.buttonGap) {
            Button { deny(request) } label: { Text(M.vaultDeny) }
                .buttonStyle(CapsuleButtonStyle(.secondary, height: VL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
            Button { approve(items.map(\.name)) } label: {
                HStack(spacing: VL.buttonGap) {
                    Icon(.faceId, size: DesignTokens.IconSize.listRow)
                    Text(M.vaultApprove)
                }
            }
            .buttonStyle(CapsuleButtonStyle(.primary, height: VL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
        }
        .disabled(busy)
    }

    private func approve(_ names: [String]) {
        busy = true
        failure = nil
        Task {
            defer { busy = false }
            do {
                try await model.approve(requestId, reason: M.vaultApproveReason(names.joined(separator: "、")))
                close()
            } catch {
                failure = VaultAssembly.message(error)
            }
        }
    }

    private func deny(_ request: VaultPendingRequest) {
        busy = true
        Task {
            defer { busy = false }
            try? await model.deny(request)
            close()
        }
    }
}
#endif
