import HimawariCore
import HimawariDesign
import SwiftUI

struct TalkTimingPage: View {
    enum Phase: Equatable {
        case loading
        case failed
        case loaded([VoiceTimingRecord])
    }

    let load: @Sendable () async throws -> [VoiceTimingRecord]
    @State private var phase: Phase = .loading

    var body: some View {
        content
            .navigationTitle(M.talkTiming)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .task { await refresh() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .himawariScreenBackground()
        case .failed:
            ContentUnavailableView {
                Label(M.talkTimingFailed, systemImage: "stopwatch")
            } actions: {
                Button(M.tryAgain) { Task { await refresh() } }
            }
            .himawariScreenBackground()
        case .loaded(let records) where records.isEmpty:
            ContentUnavailableView(M.talkTimingEmpty, systemImage: "stopwatch")
                .himawariScreenBackground()
        case .loaded(let records):
            list(records)
        }
    }

    private func list(_ records: [VoiceTimingRecord]) -> some View {
        let summary = VoiceTimingSummary(records)
        return List {
            Section {
                if summary.rounds < VoiceTimingSummary.minimumRounds {
                    Text(M.talkTimingTooFew(summary.rounds)).foregroundStyle(Color.hmMuted)
                } else {
                    LabeledContent(M.talkTimingTextGap, value: Self.spread(summary.textGap, rounds: summary.rounds))
                    LabeledContent(M.talkTimingSoundGap, value: Self.spread(summary.soundGap, rounds: summary.soundRounds))
                }
            } header: {
                Text(M.talkTimingRecent)
            } footer: {
                Text(M.talkTimingDefinition)
            }
            Section(M.talkTimingTurns) {
                ForEach(records) { record in
                    DisclosureGroup {
                        LabeledContent(M.talkTimingSaid, value: Self.moment(record.saidAt))
                        LabeledContent(M.talkTimingFirstText, value: Self.moment(record.firstTextAt))
                        LabeledContent(M.talkTimingFirstSound, value: record.firstSoundAt.map(Self.moment) ?? M.talkTimingSilent)
                        LabeledContent(M.talkTimingEmitted, value: record.emittedAt.map(Self.moment) ?? "-")
                    } label: {
                        LabeledContent(Self.day(record.saidAt), value: Self.gaps(record))
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .himawariScreenBackground()
        .refreshable { await refresh() }
    }

    private func refresh() async {
        do {
            phase = .loaded(try await load())
        } catch {
            if case .loaded = phase { return }
            phase = .failed
        }
    }

    static func seconds(_ interval: TimeInterval) -> String {
        M.seconds(interval.formatted(.number.precision(.fractionLength(1))))
    }

    static func spread(_ spread: VoiceTimingSummary.Spread?, rounds: Int) -> String {
        guard let spread else { return M.talkTimingTooFew(rounds) }
        return M.talkTimingSpread(half: seconds(spread.half), ninety: seconds(spread.ninety))
    }

    static func gaps(_ record: VoiceTimingRecord) -> String {
        "\(seconds(record.textGap)) / \(record.soundGap.map(seconds) ?? M.talkTimingSilent)"
    }

    private static let relativeDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        formatter.doesRelativeDateFormatting = true
        return formatter
    }()

    static func day(_ date: Date) -> String {
        relativeDay.string(from: date)
    }

    static func moment(_ date: Date) -> String {
        date.formatted(.dateTime.hour().minute().second().secondFraction(.fractional(3)))
    }
}
