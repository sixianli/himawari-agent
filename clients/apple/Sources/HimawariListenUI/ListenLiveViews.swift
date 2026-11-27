import HimawariCore
import HimawariDesign
import SwiftUI

public struct ListenElapsedText: View {
    private let startedAt: Date
    private let now: Date?

    public init(startedAt: Date, now: Date? = nil) {
        self.startedAt = startedAt
        self.now = now
    }

    public var body: some View {
        if let now {
            Text(Self.clock(now.timeIntervalSince(startedAt)))
        } else {
            Text(timerInterval: startedAt...Date.distantFuture, countsDown: false, showsHours: false)
        }
    }

    public static func clock(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }
}

public struct ListenIslandCompact: View {
    private let state: ListenLiveState
    private let now: Date?

    public init(state: ListenLiveState, now: Date? = nil) {
        self.state = state
        self.now = now
    }

    public var body: some View {
        HStack {
            HStack(spacing: 6) {
                SunflowerMark()
                    .frame(width: 18, height: 18)
                Text(L.text(state.phase == .paused ? "live.paused" : "live.listening"))
                    .font(.system(size: 13, weight: .semibold))
            }
            Spacer(minLength: 8)
            ListenElapsedText(startedAt: state.startedAt, now: now)
                .font(.rounded(13, weight: .regular))
                .foregroundStyle(.white.opacity(0.8))
                .monospacedDigit()
        }
        .foregroundStyle(.white)
    }
}

public struct ListenLockBanner: View {
    private let state: ListenLiveState
    private let now: Date?
    private let pause: AnyView
    private let stop: AnyView

    public init<Pause: View, Stop: View>(state: ListenLiveState, now: Date? = nil, @ViewBuilder pause: (AnyView) -> Pause, @ViewBuilder stop: (AnyView) -> Stop) {
        self.state = state
        self.now = now
        self.pause = AnyView(pause(AnyView(Self.capsule(L.text("live.pause"), primary: false))))
        self.stop = AnyView(stop(AnyView(Self.capsule(L.text("live.stop"), primary: true))))
    }

    public var body: some View {
        HStack(spacing: 12) {
            SunflowerMark()
                .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(L.text(state.phase == .paused ? "live.paused" : "live.listening"))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.hmText)
                subtitle
                    .font(.system(size: 13))
                    .foregroundStyle(Color.hmMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            pause
            stop
        }
        .padding(EdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 14))
    }

    @ViewBuilder
    private var subtitle: some View {
        if let now {
            Text("\(ListenText.source(state.route)) · \(ListenText.elapsed(now.timeIntervalSince(state.startedAt)))")
        } else {
            HStack(spacing: 0) {
                Text("\(ListenText.source(state.route)) · ")
                ListenElapsedText(startedAt: state.startedAt)
            }
        }
    }

    static func capsule(_ title: String, primary: Bool) -> some View {
        Text(title)
            .font(.system(size: 15, weight: primary ? .semibold : .regular))
            .foregroundStyle(primary ? Color.hmOnText : Color.hmText)
            .padding(.horizontal, primary ? 18 : 16)
            .frame(height: 44)
            .background(primary ? Color.hmText : Color.hmFill, in: Capsule())
    }
}

public struct ListenCallPanel: View {
    private let state: ListenLiveState
    private let levels: [Double]

    public init(state: ListenLiveState, levels: [Double]) {
        self.state = state
        self.levels = levels
    }

    public static let waveColor = Color(.sRGB, red: 242 / 255, green: 193 / 255, blue: 78 / 255, opacity: 1)

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                SunflowerMark()
                    .frame(width: 30, height: 30)
                Text(L.text("live.calling"))
                    .font(.system(size: 17, weight: .semibold))
            }
            Text("\(Text(state.heard))\(Text(state.heardTail).foregroundStyle(.white.opacity(0.55)))")
                .font(.system(size: 20))
                .lineSpacing(20 * 0.45 - 6)
                .padding(.top, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            VoiceLevels(levels: levels, color: Self.waveColor)
                .frame(height: 56)
        }
        .foregroundStyle(.white)
        .padding(EdgeInsets(top: 18, leading: 18, bottom: 14, trailing: 18))
        .modifier(LockPanelBackground())
    }
}

public struct ListenAskPanel<NotMe: View, ItsMe: View>: View {
    private let state: ListenLiveState
    private let notMe: NotMe
    private let itsMe: ItsMe

    public init(state: ListenLiveState, @ViewBuilder notMe: (AnyView) -> NotMe, @ViewBuilder itsMe: (AnyView) -> ItsMe) {
        self.state = state
        self.notMe = notMe(AnyView(Self.button(L.text("live.notMe"), primary: false)))
        self.itsMe = itsMe(AnyView(Self.button(L.text("live.itsMe"), primary: true)))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                SunflowerMark()
                    .frame(width: 30, height: 30)
                Text(L.text("live.ask"))
                    .font(.system(size: 17, weight: .semibold))
            }
            Text(ListenText.askExplanation(heard: state.heard, reason: state.refusal ?? .speakerUnconfirmed))
                .font(.system(size: 15))
                .lineSpacing(15 * 0.45 - 4)
                .foregroundStyle(.white.opacity(0.8))
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                notMe
                itsMe
            }
        }
        .foregroundStyle(.white)
        .padding(18)
        .modifier(LockPanelBackground())
    }

    static func button(_ title: String, primary: Bool) -> some View {
        HStack(spacing: 6) {
            if primary { Icon(.faceId, size: 20) }
            Text(title)
        }
        .font(.system(size: 15, weight: primary ? .semibold : .regular))
        .foregroundStyle(primary ? Color(.sRGB, red: 29 / 255, green: 31 / 255, blue: 26 / 255, opacity: 1) : .white)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(primary ? Color.white : Color.white.opacity(0.16), in: Capsule())
    }
}

struct LockPanelBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color(.sRGB, red: 120 / 255, green: 128 / 255, blue: 112 / 255, opacity: 0.42), in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 30, style: .continuous).strokeBorder(.white.opacity(0.14), lineWidth: 1))
    }
}

public struct LockScreenBackdrop<Content: View>: View {
    private let time: String
    private let date: String
    private let content: Content

    public init(time: String, date: String, @ViewBuilder content: () -> Content) {
        self.time = time
        self.date = date
        self.content = content()
    }

    public var body: some View {
        ZStack {
            LinearGradient(
                stops: [
                    .init(color: Color(.sRGB, red: 59 / 255, green: 50 / 255, blue: 20 / 255, opacity: 1), location: 0),
                    .init(color: Color(.sRGB, red: 35 / 255, green: 42 / 255, blue: 28 / 255, opacity: 1), location: 0.6),
                    .init(color: Color(.sRGB, red: 28 / 255, green: 29 / 255, blue: 26 / 255, opacity: 1), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            RadialGradient(
                colors: [Color(.sRGB, red: 122 / 255, green: 84 / 255, blue: 16 / 255, opacity: 1), .clear],
                center: UnitPoint(x: 300 / 390, y: 120 / 844),
                startRadius: 0,
                endRadius: 400
            )
            VStack(spacing: 0) {
                Text(date)
                    .font(.system(size: 20))
                    .foregroundStyle(.white.opacity(0.88))
                Text(time)
                    .font(.rounded(96, weight: .bold))
                    .tracking(-2)
                    .foregroundStyle(.white)
                Spacer(minLength: 0)
                content
                    .padding(.horizontal, 12)
                    .padding(.bottom, 34)
            }
            .padding(.top, 78)
        }
        .ignoresSafeArea()
        .environment(\.colorScheme, .dark)
    }
}

public struct LockNotificationCard: View {
    private let title: String
    private let bodyText: String
    private let when: String
    private let actions: [String]

    public init(title: String, body: String, when: String, actions: [String]) {
        self.title = title
        bodyText = body
        self.when = when
        self.actions = actions
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 10) {
                    SunflowerMark()
                        .frame(width: 24, height: 24)
                        .background(Color(.sRGB, red: 252 / 255, green: 252 / 255, blue: 251 / 255, opacity: 1), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    Text(title)
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(when)
                        .font(.system(size: 13))
                        .foregroundStyle(Color(.sRGB, red: 214 / 255, green: 215 / 255, blue: 208 / 255, opacity: 1))
                }
                if !bodyText.isEmpty {
                    Text(bodyText)
                        .font(.system(size: 15))
                        .lineSpacing(15 * 0.45 - 4)
                        .foregroundStyle(Color(.sRGB, red: 236 / 255, green: 236 / 255, blue: 232 / 255, opacity: 1))
                        .padding(.leading, 34)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !actions.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(actions.enumerated()), id: \.offset) { index, action in
                        Text(action)
                            .font(.system(size: 15, weight: index == actions.count - 1 ? .semibold : .regular))
                            .foregroundStyle(index == actions.count - 1 ? Color(.sRGB, red: 27 / 255, green: 28 / 255, blue: 25 / 255, opacity: 1) : .white)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(index == actions.count - 1 ? Color.white : Color.white.opacity(0.16), in: Capsule())
                    }
                }
            }
        }
        .foregroundStyle(.white)
        .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .background(Color.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).strokeBorder(.white.opacity(0.12), lineWidth: 1))
    }
}

extension View {
    public func listenIslandPreviewSurface() -> some View {
        self
            .frame(width: 198, height: 37)
            .background(Color.black, in: Capsule())
    }

    public func listenBannerPreviewSurface() -> some View {
        self
            .hmRaised(RoundedRectangle(cornerRadius: 30, style: .continuous), fill: Color.hmGlass, shadow: DesignTokens.Shadows.liftBig)
            .overlay(RoundedRectangle(cornerRadius: 30, style: .continuous).strokeBorder(Color.hmGlassLine, lineWidth: 1))
            .frame(width: 366)
    }
}
