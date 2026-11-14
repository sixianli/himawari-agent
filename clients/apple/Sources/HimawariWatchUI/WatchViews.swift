#if os(watchOS)
import HimawariCore
import HimawariDesign
import SwiftUI

struct WatchButtonStyle: ButtonStyle {
    let primary: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .hmType(DesignTokens.TypeScale.watchButton)
            .foregroundStyle(primary ? Color.hmOnText : Color.hmText)
            .frame(maxWidth: .infinity, minHeight: DesignTokens.Watch.buttonHeight)
            .background(primary ? Color.hmText : Color.hmFillStrong, in: Capsule())
            .opacity(configuration.isPressed ? DesignTokens.Opacity.watchPressed : 1)
    }
}

public struct WatchRootView: View {
    @State private var model: WatchModel
    @Environment(\.scenePhase) private var scenePhase

    public init(model: WatchModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        Group {
            switch model.phase {
            case let .unpaired(problem): UnpairedView(model: model, problem: problem)
            case .submitting: ConnectingView()
            case let .waitingForConfirmation(number): WaitingView(model: model, number: number)
            case .active: HomeView(model: model)
            }
        }
        .containerBackground(.black, for: .navigation)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refresh() } }
        }
    }
}

struct UnpairedView: View {
    let model: WatchModel
    let problem: PairingProblem?

    var body: some View {
        VStack(spacing: 10) {
            SunflowerMark(detail: .compact)
                .frame(width: DesignTokens.Watch.markMedium, height: DesignTokens.Watch.markMedium)
            if let problem {
                Text(Self.message(problem))
                    .hmType(DesignTokens.TypeScale.watchFootnote)
                    .foregroundStyle(Color.hmDanger)
                    .multilineTextAlignment(.center)
                Button(L.text("retry")) { model.retryPairing() }
                    .buttonStyle(WatchButtonStyle(primary: false))
            } else {
                Text(L.text("unpaired.title"))
                    .hmType(DesignTokens.TypeScale.watchSentence)
                    .foregroundStyle(Color.hmText)
                    .multilineTextAlignment(.center)
                Text(L.text("unpaired.detail"))
                    .hmType(DesignTokens.TypeScale.watchFootnote)
                    .foregroundStyle(Color.hmMuted)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, DesignTokens.Watch.screenPadding)
    }

    static func message(_ problem: PairingProblem) -> String {
        switch problem {
        case .removed: L.text("problem.removed")
        case .unreachable: L.text("problem.unreachable")
        case .codeExpired: L.text("problem.codeExpired")
        case .codeUsed: L.text("problem.codeUsed")
        default: L.text("problem.generic")
        }
    }
}

struct ConnectingView: View {
    var body: some View {
        VStack(spacing: 10) {
            SunflowerMark(detail: .compact, growing: true)
                .frame(width: DesignTokens.Watch.markPairing, height: DesignTokens.Watch.markPairing)
            Text(L.text("submitting"))
                .hmType(DesignTokens.TypeScale.watchFootnote)
                .foregroundStyle(Color.hmMuted)
        }
    }
}

struct WaitingView: View {
    let model: WatchModel
    let number: String

    var body: some View {
        VStack(spacing: 8) {
            Text(number)
                .hmType(DesignTokens.TypeScale.watchNumber)
                .monospacedDigit()
                .foregroundStyle(Color.hmSun)
            Text(L.text("waiting.title"))
                .hmType(DesignTokens.TypeScale.watchFootnote)
                .foregroundStyle(Color.hmText)
                .multilineTextAlignment(.center)
            Button(L.text("cancel")) { model.cancelPairing() }
                .buttonStyle(WatchButtonStyle(primary: false))
        }
        .padding(.horizontal, DesignTokens.Watch.screenPadding)
    }
}

struct HomeView: View {
    let model: WatchModel
    @State private var talking = false

    var body: some View {
        NavigationStack {
            Group {
                if let card = model.card {
                    CardView(model: model, card: card)
                } else {
                    QuietView(failed: model.homeFailed)
                }
            }
            .toolbar {
                ToolbarItem(placement: .bottomBar) {
                    Button { talking = true } label: {
                        SunflowerMark(detail: .compact).frame(width: DesignTokens.Watch.markSmall, height: DesignTokens.Watch.markSmall)
                    }
                    .accessibilityLabel(L.text("talk"))
                }
            }
            .sheet(isPresented: $talking, onDismiss: { model.finishTalk() }) {
                TalkView(model: model)
            }
        }
        .task { await model.refresh() }
    }
}

struct QuietView: View {
    let failed: Bool

    var body: some View {
        VStack(spacing: 8) {
            SunflowerMark(detail: .full)
                .frame(width: DesignTokens.Watch.markQuiet, height: DesignTokens.Watch.markQuiet)
            Text(L.text(failed ? "offline" : "quiet"))
                .hmType(DesignTokens.TypeScale.watchFootnote)
                .foregroundStyle(Color.hmMuted)
                .multilineTextAlignment(.center)
        }
    }
}

struct CardView: View {
    let model: WatchModel
    let card: WatchCard
    @State private var handedOff = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: DesignTokens.Watch.cardGap) {
                if let time = card.time {
                    Text(time.formatted(date: .omitted, time: .shortened))
                        .hmType(DesignTokens.TypeScale.watchTime)
                        .foregroundStyle(Color.hmSun)
                }
                Text(card.sentence)
                    .hmType(DesignTokens.TypeScale.watchSentence)
                    .foregroundStyle(Color.hmText)
                if let detail = card.detail {
                    Text(detail)
                        .hmType(DesignTokens.TypeScale.watchFootnote)
                        .foregroundStyle(Color.hmMuted)
                }
                buttons
                    .padding(.top, DesignTokens.Watch.cardButtonTop)
            }
        }
    }

    @ViewBuilder
    private var buttons: some View {
        switch card.choice {
        case let .decide(actions):
            VStack(spacing: DesignTokens.Watch.buttonGap) {
                ForEach(Array(actions.enumerated()), id: \.offset) { index, action in
                    Button(action.label) { model.decide(card, action) }
                        .buttonStyle(WatchButtonStyle(primary: actions.count > 1 && index == 0 && action.polarity == "positive"))
                        .disabled(model.acting != nil)
                }
            }
        case .handOff:
            if handedOff {
                Text(L.text("onIPhone.hint"))
                    .hmType(DesignTokens.TypeScale.watchFootnote)
                    .foregroundStyle(Color.hmMuted)
            } else {
                Button(L.text("onIPhone")) { handedOff = true }
                    .buttonStyle(WatchButtonStyle(primary: false))
            }
        }
    }
}

struct TalkView: View {
    let model: WatchModel
    @State private var text = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        GeometryReader { proxy in
            let screen = WatchScreen(
                width: proxy.size.width - DesignTokens.Watch.talkInsetWidth,
                height: proxy.size.height - DesignTokens.Watch.talkInsetHeight,
                fontSize: DesignTokens.Watch.answerSize,
                lineHeight: DesignTokens.Watch.answerLineHeight
            )
            VStack(spacing: 8) {
                switch model.talk {
                case .idle:
                    SunflowerMark(detail: .compact, growing: false).frame(width: DesignTokens.Watch.markPairing, height: DesignTokens.Watch.markPairing)
                    TextField(L.text("talk.prompt"), text: $text)
                        .submitLabel(.send)
                        .onSubmit { model.say(text, screen: screen) }
                case .sending:
                    status("talk.sending", growing: true)
                case .waiting:
                    status("talk.thinking", growing: true)
                case let .shown(reply):
                    ScrollView {
                        Text(reply)
                            .hmType(DesignTokens.TypeScale.watchAnswer)
                            .foregroundStyle(Color.hmText)
                    }
                    Button(L.text("done")) { dismiss() }
                        .buttonStyle(WatchButtonStyle(primary: false))
                case let .reading(first):
                    Text(first)
                        .hmType(DesignTokens.TypeScale.watchAnswerStrong)
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.center)
                    Text(L.text("talk.reading"))
                        .hmType(DesignTokens.TypeScale.watchFootnote)
                        .foregroundStyle(Color.hmMuted)
                    Text(L.text("talk.fullInChat"))
                        .hmType(DesignTokens.TypeScale.watchCaption)
                        .foregroundStyle(Color.hmMuted)
                    Button(L.text("stop")) { model.stopReading() }
                        .buttonStyle(WatchButtonStyle(primary: false))
                case .failed:
                    Text(L.text("talk.failed"))
                        .foregroundStyle(Color.hmDanger)
                    Button(L.text("retry")) { model.say(text, screen: screen) }
                        .buttonStyle(WatchButtonStyle(primary: false))
                }
            }
            .padding(DesignTokens.Watch.talkPadding)
        }
    }

    private func status(_ key: String, growing: Bool) -> some View {
        VStack(spacing: 8) {
            SunflowerMark(detail: .compact, growing: growing).frame(width: DesignTokens.Watch.markPairing, height: DesignTokens.Watch.markPairing)
            Text(L.text(key)).hmType(DesignTokens.TypeScale.watchFootnote).foregroundStyle(Color.hmMuted)
        }
    }
}
#endif
