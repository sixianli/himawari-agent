import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

typealias XL = ManageLayout.ExportSheet

struct DataExportPage: View {
    @Environment(\.pairingClock) private var pairingClock
    let session: DataExportSession
    let back: () -> Void
    @State private var failed = false
    @State private var archive: URL?
    @State private var downloadFailed = false
    @State private var saving = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.exportTitle, leading: .back, action: back)
            VStack(spacing: XL.gap) {
                switch session.stage {
                case .idle, .starting:
                    ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
                case .packing(let progress):
                    packing(progress)
                case .ready(let result):
                    ready(result)
                case .expired:
                    retry(M.exportExpired)
                case .failed:
                    retry(M.exportPackFailed)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, XL.topPadding)
        }
        .task {
            if session.stage == .idle { await session.start(reason: M.confirmExport) } else { await session.follow() }
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    @ViewBuilder private func packing(_ progress: DataExportProgress?) -> some View {
        SunflowerMark(growing: true).frame(width: XL.mark, height: XL.mark)
        Text(M.exportPacking).hmType(XL.title).foregroundStyle(Color.hmText)
        if let fraction = progress?.fraction {
            ProgressView(value: fraction)
                .progressViewStyle(.linear)
                .tint(Color.hmSun)
                .frame(width: XL.barWidth, height: XL.barHeight)
        }
        Text(M.exportLeaveAndReturn).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
            .multilineTextAlignment(.center)
        Spacer(minLength: DL.askTopPadding)
        Button {
            Task {
                do {
                    try await session.cancel()
                    back()
                } catch {
                    failed = true
                }
            }
        } label: {
            Text(M.stopExport).hmType(SL.rowValue).foregroundStyle(Color.hmDanger)
                .frame(minHeight: DL.linkMinHeight)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func ready(_ result: DataExportResult) -> some View {
        Icon(.circleCheck, size: XL.doneIcon).foregroundStyle(Color.hmSuccess)
        Text(M.exportReady).hmType(XL.title).foregroundStyle(Color.hmText)
        Text(M.exportContents(result)).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
            .multilineTextAlignment(.center)
        if let expiry = M.exportExpiry(result.expiresAt, now: pairingClock ?? Date()) {
            Text(expiry).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
        }
        if result.withheld > 0 {
            Text(M.exportWithheld(result.withheld)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
        }
        Spacer(minLength: DL.askTopPadding)
        VStack(spacing: XL.buttonGap) {
            if downloadFailed {
                Text(M.exportDownloadFailed).hmType(XL.title).foregroundStyle(Color.hmText).multilineTextAlignment(.center)
                Button { Task { await fetchArchive(result) } } label: { Text(M.downloadAgain) }
                    .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
            } else {
                Button { saving = true } label: {
                    Text(M.saveToFiles)
                }
                .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
                .disabled(archive == nil)
                if let archive {
                    ShareLink(item: archive) {
                        Text(M.sendElsewhere)
                            .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.pillBig)
                    }
                    .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
                } else {
                    Button {} label: { Text(M.sendElsewhere) }
                        .buttonStyle(CapsuleButtonStyle(.secondary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
                        .disabled(true)
                }
            }
        }
        .task(id: result.downloadPath) { await fetchArchive(result) }
        .fileMover(isPresented: $saving, file: archive) { outcome in
            guard case .success = outcome else { return }
            archive = nil
            Task { await fetchArchive(result) }
        }
    }

    private func fetchArchive(_ result: DataExportResult) async {
        guard archive == nil else { return }
        downloadFailed = false
        do { archive = try await session.archiveFile(named: result.fileName) } catch { downloadFailed = true }
    }

    @ViewBuilder private func retry(_ title: String) -> some View {
        Text(title).hmType(XL.title).foregroundStyle(Color.hmText).multilineTextAlignment(.center)
        Spacer(minLength: DL.askTopPadding)
        Button {
            Task { await session.start(reason: M.confirmExport) }
        } label: {
            Text(M.exportAgain)
        }
        .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.TypeScale.body.size))
    }
}
