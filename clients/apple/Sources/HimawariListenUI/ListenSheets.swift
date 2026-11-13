import HimawariCore
import HimawariDesign
import SwiftUI

struct ListenSheetHeader: View {
    let title: String
    let leading: IconName
    let leadingLabel: String
    let action: () -> Void

    var body: some View {
        HStack {
            Button(action: action) {
                Icon(leading, size: 18)
                    .foregroundStyle(Color.hmText)
                    .frame(width: 48, height: 48)
                    .background(Color.hmFill, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(leadingLabel))
            Spacer()
            Text(title)
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(Color.hmText)
            Spacer()
            Color.clear.frame(width: 48, height: 48)
        }
    }
}

struct ListenFactRow: View {
    let icon: IconName
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Icon(icon, size: 26)
                .foregroundStyle(Color.hmMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.hmMuted)
                Text(value)
                    .font(.system(size: 17))
                    .lineSpacing(17 * 0.4 - 4)
                    .foregroundStyle(Color.hmText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct ListenFactCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .himawariCard(padding: EdgeInsets(top: 20, leading: 20, bottom: 20, trailing: 20))
    }
}

struct ListenLink: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 17))
                .foregroundStyle(Color.hmSun)
                .frame(minHeight: 44)
                .padding(.horizontal, 12)
        }
        .buttonStyle(.plain)
    }
}

public struct ListenIntroView: View {
    private let onStart: () -> Void
    private let onLater: () -> Void

    public init(onStart: @escaping () -> Void, onLater: @escaping () -> Void) {
        self.onStart = onStart
        self.onLater = onLater
    }

    public var body: some View {
        VStack(spacing: 22) {
            ListenSheetHeader(title: L.text("intro.title"), leading: .chevronLeft, leadingLabel: L.text("back"), action: onLater)
            VStack(spacing: 18) {
                Icon(.earLarge, size: 72)
                    .foregroundStyle(Color.hmSun)
                Text(L.text("intro.hero"))
                    .font(.himawari(26, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.hmText)
            }
            .padding(.top, 30)
            ListenFactCard {
                ListenFactRow(icon: .eye, label: L.text("intro.what.label"), value: L.text("intro.what.value"))
                ListenFactRow(icon: .users, label: L.text("intro.others.label"), value: L.text("intro.others.value"))
                ListenFactRow(icon: .clock, label: L.text("intro.keep.label"), value: L.text("intro.keep.value"))
                ListenFactRow(icon: .point, label: L.text("intro.know.label"), value: L.text("intro.know.value"))
            }
            Text(L.text("intro.note"))
                .font(.system(size: 13))
                .lineSpacing(13 * 0.5 - 4)
                .foregroundStyle(Color.hmMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
            Spacer(minLength: 0)
            VStack(spacing: 6) {
                Button(L.text("intro.start"), action: onStart)
                    .buttonStyle(CapsuleButtonStyle(.primary, height: 56, fontSize: 17))
                ListenLink(title: L.text("intro.later"), action: onLater)
            }
        }
        .padding(EdgeInsets(top: 16, leading: 16, bottom: 40, trailing: 16))
        .background(Color.hmBackground)
    }
}

public struct EnrollmentProgress: Sendable, Equatable {
    public let index: Int
    public let total: Int
    public let prompt: String
    public let levels: [Double]

    public init(index: Int, total: Int, prompt: String, levels: [Double]) {
        self.index = index
        self.total = total
        self.prompt = prompt
        self.levels = levels
    }
}

public struct VoiceprintEnrollView: View {
    private let progress: EnrollmentProgress
    private let onClose: () -> Void
    private let onLater: () -> Void

    public init(progress: EnrollmentProgress, onClose: @escaping () -> Void, onLater: @escaping () -> Void) {
        self.progress = progress
        self.onClose = onClose
        self.onLater = onLater
    }

    public var body: some View {
        VStack(spacing: 22) {
            ListenSheetHeader(title: L.text("enroll.title"), leading: .x, leadingLabel: L.text("close"), action: onClose)
            VStack(spacing: 8) {
                Text(L.format("enroll.progress", progress.index + 1, progress.total))
                    .font(.rounded(15, weight: .semibold))
                    .foregroundStyle(Color.hmMuted)
                Text(progress.prompt)
                    .font(.himawari(26, weight: .semibold))
                    .lineSpacing(26 * 0.5 - 8)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Color.hmText)
                    .padding(.horizontal, 12)
            }
            .padding(.top, 14)
            VoiceLevels(levels: progress.levels, color: .hmSunBright)
                .frame(height: 56)
            Text(L.text("enroll.hint"))
                .font(.system(size: 15))
                .foregroundStyle(Color.hmMuted)
                .multilineTextAlignment(.center)
            ListenFactCard {
                ListenFactRow(icon: .shieldLock, label: L.text("enroll.purpose.label"), value: L.text("enroll.purpose.value"))
                ListenFactRow(icon: .deviceMobile, label: L.text("enroll.where.label"), value: L.text("enroll.where.value"))
                ListenFactRow(icon: .trash, label: L.text("enroll.delete.label"), value: L.text("enroll.delete.value"))
            }
            Spacer(minLength: 0)
            ListenLink(title: L.text("enroll.later"), action: onLater)
        }
        .padding(EdgeInsets(top: 16, leading: 16, bottom: 40, trailing: 16))
        .background(Color.hmBackground)
    }
}

public struct VoiceLevels: View {
    private let levels: [Double]
    private let color: Color

    public static let resting: [Double] = [33, 38, 35, 24, 28, 19, 44, 13, 50, 17, 39, 20, 29, 30, 35, 43, 28, 43, 16, 29, 11, 43, 21, 46, 30, 35, 28, 21, 35, 23, 48].map { $0 / 56 }

    public init(levels: [Double], color: Color) {
        self.levels = levels
        self.color = color
    }

    public var body: some View {
        HStack(spacing: 5) {
            ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(color)
                    .frame(width: 5, height: max(4, min(1, level) * 56))
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }
}

public struct ListenSheetChrome<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        ZStack(alignment: .top) {
            Color.hmScrim.ignoresSafeArea()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: DesignTokens.Radius.sheetTop, topTrailingRadius: DesignTokens.Radius.sheetTop, style: .continuous))
                .padding(.top, 58)
                .ignoresSafeArea(edges: .bottom)
        }
        .ignoresSafeArea(edges: .top)
    }
}
