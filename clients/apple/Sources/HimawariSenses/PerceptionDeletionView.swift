import HimawariCore
import HimawariDesign
import SwiftUI

public struct PerceptionDeletionView: View {
    @State private var model: PerceptionDeletionModel
    @State private var path: [String] = []
    @State private var confirming: PendingDeletion?
    @State private var confirmingKind: SenseItem?
    private let close: () -> Void

    public init(model: PerceptionDeletionModel, opening episodeId: String? = nil, close: @escaping () -> Void) {
        _model = State(initialValue: model)
        _path = State(initialValue: episodeId.map { [$0] } ?? [])
        self.close = close
    }

    public var body: some View {
        NavigationStack(path: $path) {
            SenseSheet(title: L.text("delete.title"), closes: true, back: close) {
                VStack(spacing: DesignTokens.Senses.listGap) {
                    Picker(L.text("delete.title"), selection: $model.segment) {
                        ForEach(PerceptionDeletionSegment.allCases, id: \.self) { segment in
                            Text(L.text("delete.segment.\(segment.rawValue)")).tag(segment)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    content
                }
            }
            .navigationDestination(for: String.self) { episodeId in
                PerceptionEpisodeDeletionView(model: model, episodeId: episodeId) {
                    if !path.isEmpty { path.removeLast() }
                }
            }
        }
        .task { await model.load() }
        .confirmationDialog(confirming?.title ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            if let pending = confirming {
                Button(L.text("detail.delete"), role: .destructive) {
                    confirming = nil
                    Task { await model.delete(pending.target, reason: pending.title) }
                }
            }
            Button(L.text("detail.cancel"), role: .cancel) { confirming = nil }
        } message: {
            Text(L.text("delete.confirmBody"))
        }
        .confirmationDialog(confirmingKind.map { L.format("detail.deleteConfirmTitle", $0.name) } ?? "", isPresented: Binding(get: { confirmingKind != nil }, set: { if !$0 { confirmingKind = nil } }), titleVisibility: .visible) {
            if let item = confirmingKind {
                Button(L.text("detail.delete"), role: .destructive) {
                    confirmingKind = nil
                    Task { await model.senses.deleteAll(item) }
                }
            }
            Button(L.text("detail.cancel"), role: .cancel) { confirmingKind = nil }
        } message: {
            Text(confirmingKind.map { L.format("detail.deleteConfirmBody", $0.name) } ?? "")
        }
        .alert(notice ?? "", isPresented: Binding(get: { notice != nil }, set: { if !$0 { clearNotice() } })) {
            Button(L.text("detail.ok")) { clearNotice() }
        }
    }

    private var notice: String? { model.notice ?? model.senses.notice }

    private func clearNotice() {
        model.notice = nil
        model.senses.notice = nil
    }

    @ViewBuilder
    private var content: some View {
        switch model.segment {
        case .episodes: episodes
        case .days: days
        case .kinds: kinds
        }
    }

    private var episodes: some View {
        PerceptionDeletionList {
            switch model.groupsLoad {
            case .loading where model.groups.isEmpty:
                PerceptionDeletionStatusRow(text: L.text("delete.loading"), busy: true)
            case .failed where model.groups.isEmpty:
                PerceptionDeletionStatusRow(text: L.text("delete.loadFailed"))
            default:
                if model.groups.allSatisfy({ $0.rows.isEmpty }) {
                    PerceptionDeletionStatusRow(text: L.text("delete.nothingRecent"))
                }
                ForEach(model.groups.filter { !$0.rows.isEmpty }) { group in
                    Section {
                        ForEach(Array(group.rows.enumerated()), id: \.offset) { _, row in
                            episodeRow(row)
                        }
                    } header: {
                        PerceptionDeletionHeader(text: PerceptionDeletionText.dayTitle(group.day, today: model.today))
                    }
                }
            }
            PerceptionDeletionFooter()
        }
        .refreshable { await model.loadEpisodes() }
    }

    @ViewBuilder
    private func episodeRow(_ row: PerceptionDayRow) -> some View {
        if let episode = row.episode {
            NavigationLink(value: episode.id) {
                PerceptionDeletionRow(title: PerceptionDeletionText.title(episode), detail: PerceptionDeletionText.detail(episode))
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                deleteButton { confirming = PendingDeletion(target: .episode(episode.id), title: L.format("delete.confirmEpisode", PerceptionDeletionText.title(episode))) }
            }
        } else if let record = row.record {
            PerceptionDeletionRow(title: PerceptionDeletionText.title(record), detail: PerceptionDeletionText.detail(record))
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    deleteButton { Task { await model.delete(.records([record.id]), reason: L.text("delete.reasonRecord")) } }
                }
        }
    }

    private var days: some View {
        PerceptionDeletionList {
            switch model.daysLoad {
            case .loading where model.days.isEmpty:
                PerceptionDeletionStatusRow(text: L.text("delete.loading"), busy: true)
            case .failed where model.days.isEmpty:
                PerceptionDeletionStatusRow(text: L.text("delete.loadFailed"))
            default:
                Section {
                    if model.days.isEmpty {
                        PerceptionDeletionStatusRow(text: L.format("delete.nothingInDays", model.daysReached))
                    }
                    ForEach(model.days) { day in
                        PerceptionDeletionRow(
                            title: PerceptionDeletionText.dayTitle(day.day, today: model.today),
                            detail: nil,
                            value: L.format("delete.count", day.total)
                        )
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            deleteButton {
                                confirming = PendingDeletion(target: .day(day.day, deviceId: nil), title: L.format("delete.confirmDay", PerceptionDeletionText.dayTitle(day.day, today: model.today)))
                            }
                        }
                    }
                    if model.hasEarlierDays {
                        Button {
                            Task { await model.loadDays() }
                        } label: {
                            Text(L.text("delete.earlier"))
                                .hmType(DesignTokens.TypeScale.body)
                                .foregroundStyle(Color.hmLink)
                        }
                        .buttonStyle(.pressable)
                    }
                }
            }
            PerceptionDeletionFooter()
        }
        .refreshable { await model.loadDays(reset: true) }
    }

    private var kinds: some View {
        PerceptionDeletionList {
            Section {
                ForEach(SenseItem.allCases.filter { !$0.recordTypes.isEmpty }, id: \.self) { item in
                    Button {
                        if model.canDelete { confirmingKind = item }
                    } label: {
                        SenseRow(icon: item.icon, title: item.name, detail: item.text("records"), status: "", statusColor: Color.hmMuted, showsChevron: false)
                    }
                    .buttonStyle(.pressable)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        deleteButton { confirmingKind = item }
                    }
                }
            }
            PerceptionDeletionFooter()
        }
    }

    private func deleteButton(_ action: @escaping () -> Void) -> some View {
        Button(role: .destructive, action: action) {
            Text(L.text("delete.swipe"))
        }
        .disabled(!model.canDelete || model.working)
    }
}

struct PendingDeletion: Equatable {
    let target: PerceptionDeletionTarget
    let title: String
}

struct PerceptionEpisodeDeletionView: View {
    let model: PerceptionDeletionModel
    let episodeId: String
    let back: () -> Void
    @State private var snapshot: PerceptionEpisodeSnapshot?
    @State private var failed = false
    @State private var confirming = false

    var body: some View {
        SenseSheet(title: snapshot?.episode.map(PerceptionDeletionText.title) ?? L.text("delete.episode"), back: back) {
            PerceptionDeletionList {
                if let snapshot {
                    Section {
                        ForEach(snapshot.records) { record in
                            PerceptionDeletionRow(title: PerceptionDeletionText.title(record), detail: PerceptionDeletionText.detail(record))
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button(role: .destructive) {
                                        Task { await deleteRecord(record) }
                                    } label: {
                                        Text(L.text("delete.swipe"))
                                    }
                                    .disabled(!model.canDelete || model.working)
                                }
                        }
                    } header: {
                        if let episode = snapshot.episode {
                            PerceptionDeletionHeader(text: PerceptionDeletionText.detail(episode))
                        }
                    }
                    if model.canDelete, snapshot.episode != nil {
                        Section {
                            Button { confirming = true } label: {
                                Text(L.text("delete.wholeEpisode"))
                                    .hmType(DesignTokens.TypeScale.body)
                                    .foregroundStyle(Color.hmDanger)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.pressable)
                            .disabled(model.working)
                        }
                    }
                } else if failed {
                    PerceptionDeletionStatusRow(text: L.text("delete.loadFailed"))
                } else {
                    PerceptionDeletionStatusRow(text: L.text("delete.loading"), busy: true)
                }
                PerceptionDeletionFooter()
            }
        }
        .task { await load() }
        .confirmationDialog(L.text("delete.confirmThisEpisode"), isPresented: $confirming, titleVisibility: .visible) {
            Button(L.text("detail.delete"), role: .destructive) {
                back()
                Task { await model.delete(.episode(episodeId), reason: L.text("delete.confirmThisEpisode")) }
            }
            Button(L.text("detail.cancel"), role: .cancel) {}
        } message: {
            Text(L.text("delete.confirmBody"))
        }
    }

    private func load() async {
        do {
            snapshot = try await model.episode(episodeId)
        } catch {
            failed = true
        }
    }

    private func deleteRecord(_ record: PerceptionRecordView) async {
        guard let current = snapshot else { return }
        let left = current.records.filter { $0.id != record.id }
        if left.isEmpty { back() }
        guard await model.delete(.records([record.id]), reason: L.text("delete.reasonRecord")), !left.isEmpty else { return }
        snapshot = PerceptionEpisodeSnapshot(episode: current.episode, records: left, nextCursor: current.nextCursor)
    }
}

struct PerceptionDeletionList<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        List {
            content
                .listRowBackground(Color.hmSurface)
                .listRowSeparatorTint(Color.hmSeparator)
        }
        .scrollContentBackground(.hidden)
        .perceptionDeletionListStyle()
    }
}

extension View {
    @ViewBuilder
    func perceptionDeletionListStyle() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
        #else
        listStyle(.inset)
        #endif
    }
}

struct PerceptionDeletionRow: View {
    let title: String
    let detail: String?
    var value: String? = nil

    var body: some View {
        HStack(spacing: DesignTokens.Size.rowGap) {
            VStack(alignment: .leading, spacing: DesignTokens.Senses.factLabelGap) {
                Text(title)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                    .lineLimit(1)
                if let detail {
                    Text(detail)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let value {
                Text(value)
                    .hmType(DesignTokens.TypeScale.secondary)
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct PerceptionDeletionHeader: View {
    let text: String

    var body: some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.secondary)
            .foregroundStyle(Color.hmMuted)
            .textCase(nil)
    }
}

struct PerceptionDeletionStatusRow: View {
    let text: String
    var busy = false

    var body: some View {
        HStack(spacing: DesignTokens.Size.rowGap) {
            if busy { ProgressView() }
            Text(text)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmMuted)
        }
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
    }
}

struct PerceptionDeletionFooter: View {
    var body: some View {
        Section {
        } footer: {
            Text(L.text("delete.footer"))
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
        }
    }
}

enum PerceptionDeletionText {
    static func title(_ episode: PerceptionEpisodeView) -> String {
        if let summary = firstLine(episode.summary) { return summary }
        if let preview = firstLine(episode.preview) { return preview }
        return senses(episode.senses) ?? L.text("delete.episode")
    }

    static func detail(_ episode: PerceptionEpisodeView) -> String {
        var parts = [span(episode.startedAt, episode.endedAt)]
        if let senses = senses(episode.senses) { parts.append(senses) }
        parts.append(L.format("delete.count", episode.recordCount))
        return parts.joined(separator: " · ")
    }

    static func title(_ record: PerceptionRecordView) -> String {
        firstLine(record.text) ?? firstLine(record.value("placeName")) ?? sense(record.sense)
    }

    static func detail(_ record: PerceptionRecordView) -> String {
        [clock(record.occurredAt), sense(record.sense)].joined(separator: " · ")
    }

    static func sense(_ sense: String) -> String {
        let key = "delete.sense.\(sense)"
        let text = L.text(key)
        return text == key ? sense : text
    }

    static func senses(_ list: [String]) -> String? {
        list.isEmpty ? nil : list.map(sense).joined(separator: L.text("delete.listSeparator"))
    }

    static func firstLine(_ text: String?) -> String? {
        guard let line = text?.split(whereSeparator: \.isNewline).first?.trimmingCharacters(in: .whitespaces), !line.isEmpty else { return nil }
        return line
    }

    static func span(_ start: String, _ end: String) -> String {
        let from = clock(start)
        let to = clock(end)
        return from == to ? from : from + "–" + to
    }

    static func clock(_ timestamp: String) -> String {
        guard let date = PerceptionTime.parse(timestamp) else { return "" }
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.setLocalizedDateFormatFromTemplate("HHmm")
        return formatter.string(from: date)
    }

    static func dayTitle(_ day: String, today: String?) -> String {
        if day == today { return L.text("delete.today") }
        if let today, day == PerceptionTime.shift(day: today, by: -1) { return L.text("delete.yesterday") }
        guard let noon = PerceptionTime.noon(day) else { return day }
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.setLocalizedDateFormatFromTemplate("MMMdEEE")
        return formatter.string(from: noon)
    }
}
