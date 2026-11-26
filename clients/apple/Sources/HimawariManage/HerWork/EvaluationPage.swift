import HimawariCore
import HimawariDesign
import SwiftUI

struct EvaluationPage: View {
    let store: DecisionStatsStore
    @State private var span: StatsSpan = .week

    var body: some View {
        List {
            Section {
                Picker(M.evalTitle, selection: $span) {
                    ForEach(StatsSpan.allCases) { span in
                        Text(M.statsSpan(span)).tag(span)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            if let stats = store.stats[span] {
                Section {
                    StatRow(
                        title: M.statsSpoken,
                        value: "\(stats.current.spoken)",
                        detail: nil,
                        trend: stats.spokenTrend,
                        definition: M.statsSpokenDefinition(span)
                    )
                }
                ForEach(SpokenRating.allCases) { rating in
                    Section {
                        rateRow(stats, rating)
                    }
                }
                if let recall = stats.recall {
                    Section {
                        StatRow(
                            title: M.statsRecall,
                            value: recall.share.formatted(.percent.precision(.fractionLength(0))),
                            detail: M.statsRecallValue(recall.correct, of: recall.asked),
                            trend: stats.recallTrend,
                            definition: M.statsRecallDefinition(recall.at)
                        )
                    }
                }
            } else if store.phase == .failed {
                Section {
                    Text(M.statsLoadFailed).foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #endif
        .navigationTitle(M.evalTitle)
        .refreshable { await store.load(span) }
        .task(id: span) { await store.load(span) }
    }

    @ViewBuilder
    private func rateRow(_ stats: DecisionStats, _ rating: SpokenRating) -> some View {
        switch stats.rate(rating) {
        case .value(let share, let rated, let total):
            StatRow(
                title: M.rating(rating),
                value: share.formatted(.percent.precision(.fractionLength(0))),
                detail: M.statsRated(rated, of: total),
                trend: stats.rateTrend(rating),
                definition: M.statsRateDefinition(rating)
            )
        case .tooFew(let rated):
            StatRow(
                title: M.rating(rating),
                value: "—",
                detail: M.statsTooFew(rated),
                trend: nil,
                definition: M.statsRateDefinition(rating)
            )
        }
    }
}

private struct StatRow: View {
    let title: String
    let value: String?
    let detail: String?
    let trend: StatsTrend?
    let definition: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.body)
                Spacer()
                if let value {
                    Text(value).font(.title3.weight(.semibold)).monospacedDigit()
                }
                if let trend, trend != .same {
                    Image(systemName: trend == .up ? "arrow.up.right" : "arrow.down.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(trend == .up ? M.statsUp : M.statsDown)
                }
            }
            if let detail {
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
            Text(definition).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
