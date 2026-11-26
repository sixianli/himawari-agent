import HimawariCore
import HimawariDesign
import SwiftUI

public struct SpokenExplanationSheet: View {
    @State private var store: SpokenExplanationStore
    private let close: () -> Void

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, messageId: String, close: @escaping () -> Void) {
        let gateway = ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))
        _store = State(initialValue: SpokenExplanationStore(gateway: gateway, messageId: messageId))
        self.close = close
    }

    init(store: SpokenExplanationStore) {
        _store = State(initialValue: store)
        close = {}
    }

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle(M.whyTitle)
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(M.done, action: close)
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { await store.load() }
        .alert(M.whySaveFailed, isPresented: Binding(get: { store.failedSave }, set: { store.failedSave = $0 })) {}
    }

    @ViewBuilder
    private var content: some View {
        if let explanation = store.explanation {
            List {
                Section(M.whyCause) {
                    ForEach(explanation.decisions) { decision in
                        CauseRow(decision: decision)
                    }
                }
                if !explanation.reasons.isEmpty {
                    Section(M.whyJudgment) {
                        ForEach(explanation.reasons, id: \.self) { reason in
                            Text(reason)
                                .font(.body)
                                .textSelection(.enabled)
                        }
                    }
                }
                Section(M.whyYouThink) {
                    Picker(M.whyYouThink, selection: Binding(get: { explanation.rating }, set: { rating in Task { await store.rate(rating) } })) {
                        ForEach(SpokenRating.allCases) { rating in
                            Text(M.rating(rating)).tag(Optional(rating))
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .disabled(store.saving)
                }
            }
            #if os(iOS)
            .listStyle(.insetGrouped)
            #endif
        } else if store.phase == .loading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView(M.whyLoadFailed, systemImage: "questionmark.circle")
        }
    }
}

private struct CauseRow: View {
    let decision: SpokenExplanation.Decision

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(M.causeKind(decision.cause.kind))
                    .font(.body)
                Spacer()
                Text(decision.cause.at, format: .dateTime.month().day().hour().minute())
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let summary = decision.cause.summary {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if decision.pushed {
                Label(M.whyPushed, systemImage: "bell")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
