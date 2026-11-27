import HimawariCore
import HimawariDesign
import SwiftUI

public struct SpokenExplanationCard: View {
    @State private var store: SpokenExplanationStore

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, messageId: String) {
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        _store = State(initialValue: SpokenExplanationStore(gateway: gateway, messageId: messageId))
    }

    init(store: SpokenExplanationStore) {
        _store = State(initialValue: store)
    }

    public var body: some View {
        content
            .padding(DesignTokens.Options.paddingHorizontal)
            .frame(maxWidth: DesignTokens.Size.bubbleMaxWidth, alignment: .leading)
            .background(Color.hmFillStrong, in: RoundedRectangle(cornerRadius: DesignTokens.Chat.whyCardRadius, style: .continuous))
            .task { await store.load() }
            .alert(M.whySaveFailed, isPresented: Binding(get: { store.failedSave }, set: { store.failedSave = $0 })) {}
    }

    @ViewBuilder
    private var content: some View {
        if let explanation = store.explanation {
            VStack(alignment: .leading, spacing: DesignTokens.Options.gap) {
                section(M.whyCause) {
                    ForEach(explanation.decisions) { decision in
                        CauseLine(decision: decision)
                    }
                }
                if !explanation.reasons.isEmpty {
                    Divider()
                    section(M.whyJudgment) {
                        ForEach(explanation.reasons, id: \.self) { reason in
                            Text(reason)
                                .font(.subheadline)
                                .foregroundStyle(Color.hmText)
                                .textSelection(.enabled)
                        }
                    }
                }
                if explanation.decisions.contains(where: \.pushed) {
                    Label(M.whyPushed, systemImage: "bell")
                        .font(.footnote)
                        .foregroundStyle(Color.hmMuted)
                }
                Divider()
                section(M.whyYouThink) {
                    HStack(spacing: DesignTokens.Options.gap) {
                        ForEach(SpokenRating.allCases) { rating in
                            RatingButton(
                                title: M.rating(rating),
                                selected: explanation.rating == rating
                            ) {
                                Task { await store.rate(explanation.rating == rating ? nil : rating) }
                            }
                            .disabled(store.saving)
                        }
                    }
                }
            }
        } else if store.phase == .loading {
            ProgressView()
                .frame(maxWidth: .infinity)
        } else {
            Label(M.whyLoadFailed, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(Color.hmMuted)
        }
    }

    private func section(_ title: String, @ViewBuilder _ body: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.Chat.answerBlockGap / 2) {
            Text(title)
                .font(.footnote)
                .foregroundStyle(Color.hmMuted)
            body()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct RatingButton: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        if selected {
            Button(action: action) { label }
                .buttonStyle(.borderedProminent)
                .accessibilityAddTraits(.isSelected)
        } else {
            Button(action: action) { label }
                .buttonStyle(.bordered)
        }
    }

    private var label: some View {
        Text(title)
            .frame(maxWidth: .infinity)
    }
}

private struct CauseLine: View {
    let decision: SpokenExplanation.Decision

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Chat.answerBlockGap / 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(M.causeKind(decision.cause.kind))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.hmText)
                Spacer(minLength: DesignTokens.Options.gap)
                Text(decision.cause.at, format: .dateTime.month().day().hour().minute())
                    .font(.footnote)
                    .foregroundStyle(Color.hmMuted)
            }
            if let summary = decision.cause.summary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(Color.hmMuted)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
