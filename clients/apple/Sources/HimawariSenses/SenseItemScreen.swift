import HimawariCore
import HimawariDesign
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct SenseItemScreen: View {
    let model: SensesModel
    let item: SenseItem
    let back: () -> Void

    var body: some View {
        switch model.screen(item) {
        case .intro: SenseIntroView(model: model, item: item, back: back)
        case .denied: SenseDeniedView(item: item, back: back)
        case .detail: SenseDetailView(model: model, item: item, back: back)
        }
    }
}

struct SenseIntroView: View {
    let model: SensesModel
    let item: SenseItem
    let back: () -> Void
    @Environment(\.senseOpensAutomatically) private var opensAutomatically

    var body: some View {
        SenseSheet(title: item.name, back: back) {
            ScrollView {
                VStack(spacing: DesignTokens.Senses.introGap) {
                    VStack(spacing: DesignTokens.Senses.introTitleGap) {
                        Icon(item.largeIcon, size: DesignTokens.Senses.introIcon)
                            .foregroundStyle(Color.hmSun)
                        Text(item.text("headline"))
                            .hmType(DesignTokens.TypeScale.senseTitle)
                            .foregroundStyle(Color.hmText)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, DesignTokens.Senses.introTop)
                    VStack(alignment: .leading, spacing: DesignTokens.Senses.factGap) {
                        SenseFact(icon: .eye, label: L.text("intro.records"), value: item.text("records"))
                        SenseFact(icon: .clock, label: L.text("intro.keep"), value: keepText)
                        SenseFact(icon: .server, label: L.text("intro.where"), value: L.text("intro.whereValue"))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .himawariCard(padding: EdgeInsets(
                        top: DesignTokens.Senses.factPadding,
                        leading: DesignTokens.Senses.factPadding,
                        bottom: DesignTokens.Senses.factPadding,
                        trailing: DesignTokens.Senses.factPadding
                    ))
                }
            }
            .scrollIndicators(.hidden)
            SenseActions(
                primary: L.format("intro.open", item.name),
                secondary: L.text("intro.later"),
                busy: model.working == item,
                primaryAction: { Task { await model.turnOn(item) } },
                secondaryAction: back
            )
        }
        .task {
            guard opensAutomatically else { return }
            try? await Task.sleep(for: .milliseconds(600))
            await model.turnOn(item)
        }
    }

    private var keepText: String {
        if item.isMirror { return item.text("keep") }
        if let days = model.retention(item)?.days ?? model.configuredRetention(item) {
            return L.format("intro.keepTrack", days)
        }
        return L.text("intro.keepUntilDeleted")
    }
}

struct SenseFact: View {
    let icon: IconName
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: DesignTokens.Size.rowGap) {
            Icon(icon, size: DesignTokens.IconSize.processRow)
                .foregroundStyle(Color.hmMuted)
            VStack(alignment: .leading, spacing: DesignTokens.Senses.factLabelGap) {
                Text(label)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                Text(value)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct SenseActions: View {
    let primary: String
    let secondary: String
    let busy: Bool
    let primaryAction: () -> Void
    let secondaryAction: () -> Void

    var body: some View {
        VStack(spacing: DesignTokens.Senses.actionGap) {
            Button(action: primaryAction) {
                Text(primary)
            }
            .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig))
            .allowsHitTesting(!busy)
            Button(action: secondaryAction) {
                Text(secondary)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmSun)
                    .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.minTapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
        }
        .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
    }
}

struct SenseDeniedView: View {
    let item: SenseItem
    let back: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        SenseSheet(title: item.name, back: back) {
            VStack(spacing: DesignTokens.Senses.introTitleGap) {
                Icon(item.largeIcon, size: DesignTokens.Senses.introIcon)
                    .foregroundStyle(Color.hmText)
                Text(item.text("denied"))
                    .hmType(DesignTokens.TypeScale.senseTitle)
                    .foregroundStyle(Color.hmText)
                    .multilineTextAlignment(.center)
                Text(L.text("denied.body") + "\n" + item.text("deniedDetail"))
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, DesignTokens.Senses.introTop)
            Spacer()
            SenseActions(
                primary: L.text("denied.openSettings"),
                secondary: L.text("denied.skip"),
                busy: false,
                primaryAction: openSettings,
                secondaryAction: back
            )
        }
    }

    private func openSettings() {
        #if canImport(UIKit)
        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        #endif
    }
}

extension EnvironmentValues {
    @Entry public var senseOpensAutomatically: Bool = false
}
