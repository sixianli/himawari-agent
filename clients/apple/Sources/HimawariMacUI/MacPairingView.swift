#if os(macOS)
import AppKit
import HimawariCore
import HimawariDesign
import HimawariShell
import SwiftUI

struct MacPairingView: View {
    let model: AppModel
    @State private var link = ""

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Mac.checklistGap) {
            SunflowerBadge(size: DesignTokens.Mac.pairingMark)
            Text(L.text("pairing.title"))
                .hmType(DesignTokens.TypeScale.macChecklistTitle)
                .foregroundStyle(Color.hmText)
            content
        }
        .padding(DesignTokens.Mac.pairingPadding)
        .frame(width: DesignTokens.Mac.pairingWidth, alignment: .leading)
        .background(Color.hmBackground)
        .animation(.easeInOut, value: model.phase)
        .onAppear(perform: fillFromClipboard)
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in fillFromClipboard() }
    }

    private func fillFromClipboard() {
        guard link.isEmpty, let text = NSPasteboard.general.string(forType: .string), (try? PairingInvitation.parse(text)) != nil else { return }
        link = text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @ViewBuilder
    private var content: some View {
        switch model.phase {
        case let .confirmingServer(host):
            Text(L.text("pairing.server")).hmType(DesignTokens.TypeScale.macLabel).foregroundStyle(Color.hmMuted)
            Text(host).hmType(DesignTokens.TypeScale.macRowStrong).foregroundStyle(Color.hmText).textSelection(.enabled)
            HStack(spacing: DesignTokens.Mac.buttonGap) {
                Spacer()
                Button(L.text("pairing.cancel"), action: model.declineScannedServer).buttonStyle(MacButtonStyle(role: .secondary))
                Button(L.text("pairing.connect"), action: model.connectToScannedServer).buttonStyle(MacButtonStyle(role: .primary))
            }
        case .submitting:
            ProgressView().controlSize(.small)
        case let .waitingForConfirmation(number):
            Text(number)
                .hmType(DesignTokens.TypeScale.pairingNumber)
                .monospacedDigit()
                .foregroundStyle(Color.hmText)
            Text(L.text("pairing.waiting")).hmType(DesignTokens.TypeScale.macRow).foregroundStyle(Color.hmMuted)
            HStack {
                Spacer()
                Button(L.text("pairing.cancel"), action: model.cancelPairing).buttonStyle(MacButtonStyle(role: .secondary))
            }
        case .active:
            EmptyView()
        case let .unpaired(problem):
            Text(L.text("pairing.step1"))
                .hmType(DesignTokens.TypeScale.macRow)
                .foregroundStyle(Color.hmText)
                .fixedSize(horizontal: false, vertical: true)
            TextField(L.text("pairing.paste"), text: $link)
                .textFieldStyle(.roundedBorder)
                .onSubmit { model.pair(scanned: link) }
            if problem != nil {
                Text(L.text("pairing.problem")).hmType(DesignTokens.TypeScale.macSmall).foregroundStyle(Color.hmDanger)
            }
            Text(L.text("pairing.step2"))
                .hmType(DesignTokens.TypeScale.macSmall)
                .foregroundStyle(Color.hmMuted)
            HStack(spacing: DesignTokens.Mac.buttonGap) {
                Spacer()
                Button(L.text("pairing.connect")) { model.pair(scanned: link) }
                    .buttonStyle(MacButtonStyle(role: .primary))
                    .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}
#endif
