#if os(macOS)
import HimawariCore
import HimawariDesign
import SwiftUI

struct PanelView: View {
    let model: MenuBarModel
    let talk: () -> Void
    let pair: () -> Void

    var body: some View {
        GlassPanel(radius: DesignTokens.Mac.panelRadius) {
            VStack(spacing: DesignTokens.Mac.panelGap) {
                if model.app.phase != .active {
                    card { notPaired }
                } else {
                    ForEach(model.shownNotices) { notice in
                        card { noticeCard(notice) }
                    }
                    ForEach(model.running) { work in
                        card { running(work) }
                    }
                    if let item = model.mostPressing {
                        card { awaiting(item) }
                    }
                    talkRow
                }
            }
            .padding(DesignTokens.Mac.panelPadding)
        }
        .frame(width: DesignTokens.Mac.panelWidth)
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.Mac.panelGap) { content() }
            .padding(DesignTokens.Mac.panelCardPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.hmSurface, in: RoundedRectangle(cornerRadius: DesignTokens.Mac.panelCardRadius, style: .continuous))
    }

    private func label(_ key: String) -> some View {
        Text(L.text(key))
            .hmType(DesignTokens.TypeScale.macLabel)
            .foregroundStyle(Color.hmMuted)
    }

    @ViewBuilder
    private func running(_ work: RunningWork) -> some View {
        label("panel.running")
        HStack(spacing: DesignTokens.Mac.panelGap) {
            Text(work.title)
                .hmType(DesignTokens.TypeScale.macRowStrong)
                .foregroundStyle(Color.hmText)
                .frame(maxWidth: .infinity, alignment: .leading)
            if model.canStop {
                Button(L.text("panel.stop")) { model.stop(work.id) }
                    .buttonStyle(MacButtonStyle(role: .secondary, height: DesignTokens.Mac.smallButtonHeight, small: true))
            }
        }
        if let progress = work.progress {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.hmFillStrong)
                    Capsule().fill(Color.hmText).frame(width: proxy.size.width * progress.fraction)
                }
            }
            .frame(height: DesignTokens.Mac.progressHeight)
        }
        if let text = work.progressLabel {
            Text(text)
                .hmType(DesignTokens.TypeScale.macSmall)
                .monospacedDigit()
                .foregroundStyle(Color.hmMuted)
        }
    }

    @ViewBuilder
    private func awaiting(_ item: HomeItem) -> some View {
        label("panel.awaiting")
        Text(item.sentence ?? "")
            .hmType(DesignTokens.TypeScale.macSentence)
            .foregroundStyle(Color.hmText)
            .fixedSize(horizontal: false, vertical: true)
        if !item.shownActions.isEmpty {
            HStack(spacing: DesignTokens.Mac.cardButtonGap) {
                ForEach(Array(item.shownActions.enumerated()), id: \.offset) { _, action in
                    Button { model.respond(item, with: action) } label: {
                        Text(action.label).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(MacButtonStyle(role: action.polarity == "positive" ? .primary : .secondary, height: DesignTokens.Mac.cardButtonHeight, small: true))
                    .disabled(model.acting == item.key)
                }
            }
        }
        if model.failedItem == item.key {
            Text(L.text("panel.actionFailed"))
                .hmType(DesignTokens.TypeScale.macSmall)
                .foregroundStyle(Color.hmMuted)
        }
    }

    @ViewBuilder
    private func noticeCard(_ notice: DeviceNotification) -> some View {
        Text(notice.title)
            .hmType(DesignTokens.TypeScale.macRowStrong)
            .foregroundStyle(Color.hmText)
            .fixedSize(horizontal: false, vertical: true)
        if !notice.body.isEmpty {
            Text(notice.body)
                .hmType(DesignTokens.TypeScale.macSmall)
                .foregroundStyle(Color.hmMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        Button(L.text("panel.noticeDismiss")) { model.dismiss(notice) }
            .buttonStyle(MacButtonStyle(role: .secondary, height: DesignTokens.Mac.smallButtonHeight, small: true))
    }

    private var talkRow: some View {
        Button(action: talk) {
            HStack {
                Text(L.text("panel.talk"))
                    .hmType(DesignTokens.TypeScale.macButton)
                    .foregroundStyle(Color.hmMuted)
                Spacer()
                if let shortcut = model.activeShortcutLabel {
                    Text(shortcut)
                        .hmType(DesignTokens.TypeScale.macLabel)
                        .foregroundStyle(Color.hmMuted)
                }
            }
            .padding(.horizontal, DesignTokens.Mac.panelCardPadding)
            .frame(height: DesignTokens.Mac.talkRowHeight)
            .background(Capsule().fill(Color.hmFill))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var notPaired: some View {
        Text(L.text("panel.notPaired"))
            .hmType(DesignTokens.TypeScale.macRowStrong)
            .foregroundStyle(Color.hmText)
        Button(L.text("panel.pair"), action: pair)
            .buttonStyle(MacButtonStyle(role: .primary, height: DesignTokens.Mac.cardButtonHeight, small: true))
    }
}
#endif
