#if canImport(CoreImage)
import CoreImage
import CoreImage.CIFilterBuiltins
#endif
import HimawariDesign
import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

typealias DL = ManageLayout.DeviceSheet

extension PairedDevice {
    var icon: IconName {
        switch kind {
        case "watch": .deviceWatch
        case "mac": .deviceLaptop
        default: .deviceMobile
        }
    }
}

struct DevicesGroup: View {
    let store: SettingsStore
    let open: (PairedDevice) -> Void
    let add: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: SL.groupGap) {
            Text(M.myDevices)
                .hmType(DesignTokens.TypeScale.groupLabel)
                .foregroundStyle(Color.hmMuted)
                .padding(.horizontal, SL.groupLabelPadding)
            if !store.devices.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(store.devices.enumerated()), id: \.element.id) { index, device in
                        Button { open(device) } label: {
                            DeviceRow(
                                device: device,
                                title: store.isThisDevice(device) && device.kind == "iphone" ? M.thisIPhone : device.name,
                                presence: store.presence(device),
                                last: index == store.devices.count - 1
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .himawariCard(padding: EdgeInsets())
            }
            Button(action: add) {
                Text(M.addDevice).hmType(SL.rowValue).foregroundStyle(Color.hmSun)
                    .frame(minHeight: DL.linkMinHeight)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, DL.addLinkPadding)
        }
    }
}

struct DeviceRow: View {
    let device: PairedDevice
    let title: String
    let presence: DevicePresence
    let last: Bool

    var body: some View {
        HStack(spacing: DL.rowGap) {
            Icon(device.icon, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmText)
            HStack(spacing: DL.rowTextGap) {
                Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(M.presence(presence)).hmType(SL.rowValue)
                    .foregroundStyle(presence == .connected ? Color.hmSuccess : Color.hmMuted)
            }
            .padding(.trailing, DL.rowTrailingPadding)
            .frame(maxHeight: .infinity)
            .overlay(alignment: .bottom) { if !last { RowSeparator() } }
        }
        .padding(.leading, SL.rowsPaddingHorizontal)
        .frame(minHeight: SL.rowMinHeight)
        .contentShape(Rectangle())
    }
}

struct DevicePage: View {
    let store: SettingsStore
    let deviceId: String
    let removedThisDevice: () -> Void
    let back: () -> Void
    @State private var renaming = false
    @State private var draftName = ""
    @State private var failed = false

    private var device: PairedDevice? { store.devices.first { $0.id == deviceId } }

    var body: some View {
        SettingsPage(gap: DL.detailGap) {
            if let device {
                SheetHeader(title: device.name, leading: .back, action: back)
                SettingsGroup(label: nil) {
                    Button {
                        draftName = device.name
                        renaming = true
                    } label: {
                        SettingsRow(icon: nil, title: M.deviceName, value: device.name, chevron: true)
                    }
                    .buttonStyle(.plain)
                    presenceRow(device)
                    let channel = M.channel(device.releaseChannel)
                    SettingsRow(icon: nil, title: M.pairedOn, value: Timestamp.parse(device.pairedAt).map(M.shortDate), last: channel == nil)
                    if let channel {
                        SettingsRow(icon: nil, title: M.deviceVersion, value: channel, last: true)
                    }
                }
                Button {
                    Task {
                        do {
                            let wasThisDevice = store.isThisDevice(device)
                            try await store.revoke(device, reason: M.confirmRemove(device.name))
                            if wasThisDevice { removedThisDevice() } else { back() }
                        } catch {
                            failed = true
                        }
                    }
                } label: {
                    Text(M.removeDevice).hmType(SL.rowValue).foregroundStyle(Color.hmDanger)
                        .frame(minHeight: DL.linkMinHeight)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, DL.addLinkPadding)
            } else {
                SheetHeader(title: "", leading: .back, action: back)
            }
        }
        .alert(M.renameTitle, isPresented: $renaming) {
            TextField(M.deviceName, text: $draftName)
            Button(M.cancel, role: .cancel) {}
            Button(M.ok) { rename() }
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func presenceRow(_ device: PairedDevice) -> some View {
        let presence = store.presence(device)
        return VStack(spacing: 0) {
            HStack {
                Text(presence == .connected ? M.deviceNow : M.lastConnected).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(M.presence(presence)).hmType(SL.rowValue)
                    .foregroundStyle(presence == .connected ? Color.hmSuccess : Color.hmMuted)
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            RowSeparator()
        }
    }

    private func rename() {
        guard let device else { return }
        guard let name = DeviceName.accepted(draftName) else {
            failed = true
            return
        }
        guard name != device.name else { return }
        Task {
            do {
                try await store.rename(device, to: name, reason: M.confirmRename(name))
            } catch {
                failed = true
            }
        }
    }
}

struct AddDevicePage: View {
    @Environment(\.pairingClock) private var pairingClock
    let store: SettingsStore
    let back: () -> Void
    @State private var session: PairingSession
    @State private var failed = false

    init(store: SettingsStore, session: PairingSession? = nil, back: @escaping () -> Void) {
        self.store = store
        self.back = back
        _session = State(initialValue: session ?? PairingSession(store: store))
    }

    var body: some View {
        SettingsPage(gap: DL.pairingGap) {
            SheetHeader(title: M.addDevice, leading: .back, action: back)
            switch session.stage {
            case .starting:
                ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
            case .showing(let link, let expiresAt):
                scan(link: link, expiresAt: expiresAt)
            case .expired(let minutes):
                expired(minutes)
            case .failed:
                couldNotStart
            case .asking(let device):
                ask(device)
            }
        }
        .task { await session.run(reason: M.confirmAddDevice) }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func expiryLine(_ expiresAt: Date, now: Date) -> some View {
        Text(M.expiresIn(max(0, Int(expiresAt.timeIntervalSince(now)))))
            .hmType(DesignTokens.TypeScale.secondary)
            .foregroundStyle(Color.hmMuted)
    }

    private func scan(link: String, expiresAt: Date) -> some View {
        VStack(spacing: DL.detailGap) {
            QRCodeView(text: link)
                .frame(width: DL.qrCode, height: DL.qrCode)
                .clipShape(RoundedRectangle(cornerRadius: DL.qrCodeRadius, style: .continuous))
                .frame(width: DL.qrCard, height: DL.qrCard)
                .background(Color.hmSurface, in: RoundedRectangle(cornerRadius: DL.qrCardRadius, style: .continuous))
            Text(M.scanWithNewDevice).hmType(DL.scanTitle).foregroundStyle(Color.hmText).multilineTextAlignment(.center)
            if let frozenNow = pairingClock {
                expiryLine(expiresAt, now: frozenNow)
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    expiryLine(expiresAt, now: context.date)
                }
            }
            Spacer(minLength: DL.askTopPadding)
            ShareLink(item: link) {
                Text(M.sendPairingLink).hmType(SL.rowValue).foregroundStyle(Color.hmSun)
                    .frame(minHeight: DL.linkMinHeight)
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, DL.scanTopPadding)
    }

    private func again() {
        Task { await session.run(reason: M.confirmAddDevice) }
    }

    private func expired(_ minutes: Int?) -> some View {
        VStack(spacing: DL.expiredGap) {
            Icon(.qrcodeOff, size: DL.expiredIcon).foregroundStyle(Color.hmMuted)
                .frame(width: DL.expiredCard, height: DL.expiredCard)
                .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DL.expiredCardRadius, style: .continuous))
            Text(M.codeExpired).hmType(DL.expiredTitle).foregroundStyle(Color.hmText)
            Text(M.codeExpiredHint(minutes: minutes)).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                .multilineTextAlignment(.center)
            Spacer(minLength: DL.askTopPadding)
            Button(action: again) {
                HStack(spacing: DL.buttonGap) {
                    Icon(.faceId, size: DL.actionIcon)
                    Text(M.makeAnother)
                }
            }
            .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, DL.expiredTopPadding)
    }

    private var couldNotStart: some View {
        VStack(spacing: DL.detailGap) {
            Text(M.actionFailed).hmType(DL.scanTitle).foregroundStyle(Color.hmText).multilineTextAlignment(.center)
            Button(action: again) {
                Text(M.makeAnother).hmType(SL.rowValue).foregroundStyle(Color.hmSun)
                    .frame(minHeight: DL.linkMinHeight)
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, DL.askTopPadding)
    }

    private func ask(_ device: PairedDevice) -> some View {
        VStack(spacing: DL.detailGap) {
            Icon(device.icon, size: DL.kindIcon).foregroundStyle(Color.hmText)
            Text(M.wantsToPair(device.name)).hmType(DL.askTitle).foregroundStyle(Color.hmText).multilineTextAlignment(.center)
            Text(M.pairingNumber(device.pairingNumber ?? "")).hmType(DL.pairingNumber).foregroundStyle(Color.hmText)
            Text(M.sameNumberHint).hmType(DL.hint).foregroundStyle(Color.hmMuted).multilineTextAlignment(.center)
            Spacer(minLength: DL.askTopPadding)
            HStack(spacing: DL.buttonGap) {
                Button(M.notMine) { decide { try await session.refuse(device, reason: M.refusePair(device.name)) } }
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
                Button(M.confirm) { decide { try await session.confirm(device, reason: M.confirmPair(device.name)) } }
                    .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, DL.askTopPadding)
    }

    private func decide(_ action: @escaping () async throws -> Void) {
        Task {
            do {
                try await action()
                back()
            } catch {
                failed = true
            }
        }
    }
}

struct QRCodeView: View {
    let text: String

    var body: some View {
        if let image = Self.render(text) {
            Image(decorative: image, scale: 1).interpolation(.none).resizable().scaledToFit()
        } else {
            Color.hmFill
        }
    }

    static func render(_ text: String) -> CGImage? {
        #if canImport(CoreImage)
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
        #else
        return nil
        #endif
    }
}

extension EnvironmentValues {
    @Entry var pairingClock: Date? = nil
}
