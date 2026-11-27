import HimawariCore
import HimawariDesign
import SwiftUI

struct SenseDetailView: View {
    let model: SensesModel
    let item: SenseItem
    let back: () -> Void
    @State private var confirming = false
    @State private var stopping = false

    var body: some View {
        SenseSheet(title: item.name, back: back) {
            ScrollView {
                VStack(alignment: .leading, spacing: DesignTokens.Senses.listGap) {
                    switchCard
                    if !item.isMirror, collecting || hasLines { todaySection }
                    keepSection
                    dangerLink
                }
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
            }
            .scrollIndicators(.hidden)
        }
        .task(id: collecting) { await model.loadDay(item) }
        .confirmationDialog(L.format("detail.stopTitle", item.name), isPresented: $stopping, titleVisibility: .visible) {
            Button(L.text("detail.stopKeep")) { Task { await model.turnOff(item) } }
            Button(L.text("detail.stopDelete"), role: .destructive) { Task { await model.turnOffAndClear(item) } }
            Button(L.text("detail.cancel"), role: .cancel) {}
        } message: {
            Text(L.text("detail.stopBody"))
        }
        .confirmationDialog(confirmTitle, isPresented: $confirming, titleVisibility: .visible) {
            Button(confirmButton, role: .destructive) {
                Task {
                    if item.isMirror { await model.turnOffAndClear(item) } else { await model.deleteAll(item) }
                }
            }
            Button(L.text("detail.cancel"), role: .cancel) {}
        } message: {
            Text(confirmBody)
        }
    }

    private var collecting: Bool {
        let state = model.state(item)
        return state == .on || state == .serverPaused
    }

    private var day: PerceptionDaySnapshot? {
        if case let .loaded(day) = model.days[item] { return day }
        return nil
    }

    private var lines: [SenseLine] { day.map(SenseLines.lines) ?? [] }

    private var hasLines: Bool { !lines.isEmpty }

    private var switchCard: some View {
        Toggle(isOn: Binding(get: { collecting }, set: { on in
            if !on, item.isMirror {
                stopping = true
            } else {
                Task { await model.setSwitch(item, on: on) }
            }
        })) {
            VStack(alignment: .leading, spacing: DesignTokens.Senses.factLabelGap) {
                Text(item.text("headline"))
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                if let caption {
                    Text(caption)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                }
            }
        }
        .disabled(model.working == item)
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
        .himawariCard(padding: EdgeInsets(top: 0, leading: DesignTokens.Size.cardPaddingX, bottom: 0, trailing: DesignTokens.Size.cardPaddingX))
    }

    private var caption: String? {
        if model.state(item) == .serverPaused { return L.text("state.paused") }
        if item.isMirror {
            return model.mirrorCounts[item].map { L.format("item.\(item.rawValue).synced", $0) }
        }
        return day.map { L.format("detail.today", $0.total) }
    }

    @ViewBuilder
    private var todaySection: some View {
        GroupedSection(Text(L.text("detail.todayList"))) {
            switch model.days[item] {
            case .failed:
                note(L.text("detail.loadFailed"))
            case .loaded where lines.isEmpty:
                note(L.text("detail.nothingYet"))
            case .loaded:
                ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                    if index > 0 { RowSeparator() }
                    NavigationLink {
                        SenseRecordView(item: item, line: line)
                    } label: {
                        SenseLineRow(line: line)
                    }
                    .buttonStyle(.pressable)
                }
            case .loading, nil:
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.rowMinHeight)
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.secondary)
            .foregroundStyle(Color.hmMuted)
            .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.rowMinHeight, alignment: .leading)
    }

    @ViewBuilder
    private var keepSection: some View {
        GroupedSection(Text(L.text("detail.keepSection"))) {
            if item.isMirror {
                note(item.text("keep"))
            } else if let retention = model.retention(item) {
                NavigationLink {
                    SenseRetentionView(model: model, item: item, retention: retention)
                } label: {
                    SenseValueRow(title: L.text("detail.route"), value: L.format("detail.routeDays", retention.days), showsChevron: true)
                }
                .buttonStyle(.pressable)
            } else {
                SenseValueRow(title: L.text("detail.kept"), value: L.text("intro.keepUntilDeleted"), showsChevron: false)
            }
            if item.retentionKey != nil {
                RowSeparator()
                placesRow
            }
            if let always = model.always[item] {
                RowSeparator()
                Toggle(isOn: Binding(get: { always }, set: { on in
                    guard on else { return }
                    Task { await model.requestAlways(item) }
                })) {
                    VStack(alignment: .leading, spacing: DesignTokens.Senses.factLabelGap) {
                        Text(L.text("detail.always"))
                            .hmType(DesignTokens.TypeScale.body)
                            .foregroundStyle(Color.hmText)
                        Text(L.text(always ? "detail.alwaysOn" : "detail.alwaysDetail"))
                            .hmType(DesignTokens.TypeScale.caption)
                            .foregroundStyle(Color.hmMuted)
                    }
                }
                .disabled(always || !collecting)
                .frame(minHeight: DesignTokens.Size.rowMinHeight)
            }
        }
    }

    private var placesRow: some View {
        HStack(spacing: DesignTokens.Size.rowGap) {
            SenseValueRow(title: L.text("detail.places"), value: L.text("detail.placesKept"), showsChevron: false)
            if model.canDelete {
                Button { confirming = true } label: {
                    Text(L.text("detail.delete"))
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmDanger)
                        .frame(minHeight: DesignTokens.Size.minTapTarget)
                }
                .buttonStyle(.pressable)
                .disabled(model.working == item)
            }
        }
    }

    private var showsDangerLink: Bool {
        item.isMirror ? model.serverCopyRemovable(item) : model.canDelete && item.retentionKey == nil
    }

    @ViewBuilder
    private var dangerLink: some View {
        if showsDangerLink {
            Button { confirming = true } label: {
                Text(item.isMirror ? item.text("deleteAll") : L.format("detail.deleteAll", item.name))
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmDanger)
                    .frame(minHeight: DesignTokens.Size.minTapTarget)
                    .padding(.horizontal, DesignTokens.Senses.footnotePaddingX)
            }
            .buttonStyle(.pressable)
            .disabled(model.working == item)
        }
    }

    private var confirmTitle: String {
        item.isMirror ? item.text("deleteAll") : L.format("detail.deleteConfirmTitle", item.name)
    }

    private var confirmBody: String {
        item.isMirror ? item.text("confirm") : L.format("detail.deleteConfirmBody", item.name)
    }

    private var confirmButton: String {
        L.text("detail.delete")
    }
}

struct SenseValueRow: View {
    let title: String
    let value: String
    let showsChevron: Bool

    var body: some View {
        HStack(spacing: DesignTokens.Size.rowGap) {
            Text(title)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(value)
                .hmType(DesignTokens.TypeScale.secondary)
                .foregroundStyle(Color.hmMuted)
            if showsChevron {
                Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                    .foregroundStyle(Color.hmMuted)
            }
        }
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
        .contentShape(Rectangle())
    }
}

struct SenseLineRow: View {
    let line: SenseLine

    var body: some View {
        HStack(spacing: DesignTokens.Size.rowGap) {
            Text(SenseLines.time(line.at))
                .hmType(DesignTokens.TypeScale.senseTime)
                .foregroundStyle(Color.hmMuted)
                .monospacedDigit()
                .frame(width: DesignTokens.Senses.timeColumn, alignment: .leading)
            Text(line.title)
                .hmType(DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Icon(.chevronRight, size: DesignTokens.IconSize.chevron)
                .foregroundStyle(Color.hmMuted)
        }
        .frame(minHeight: DesignTokens.Size.rowMinHeight)
        .contentShape(Rectangle())
    }
}

struct SenseRecordView: View {
    let item: SenseItem
    let line: SenseLine
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        SenseSheet(title: item.name, back: { dismiss() }) {
            ScrollView {
                GroupedSection {
                    ForEach(Array(facts.enumerated()), id: \.offset) { index, fact in
                        if index > 0 { RowSeparator() }
                        VStack(alignment: .leading, spacing: DesignTokens.Senses.factLabelGap) {
                            Text(fact.label)
                                .hmType(DesignTokens.TypeScale.caption)
                                .foregroundStyle(Color.hmMuted)
                            Text(fact.value)
                                .hmType(DesignTokens.TypeScale.body)
                                .foregroundStyle(Color.hmText)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.rowMinHeight, alignment: .leading)
                    }
                }
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
            }
            .scrollIndicators(.hidden)
        }
    }

    private var facts: [(label: String, value: String)] {
        let record = line.record
        var result: [(String, String)] = [
            (L.text("record.time"), line.at.formatted(date: .abbreviated, time: .shortened)),
            (L.text("record.what"), line.title),
        ]
        if let place = record.value("placeName") { result.append((L.text("record.place"), place)) }
        if let latitude = record.number("latitude"), let longitude = record.number("longitude") {
            var value = String(format: "%.5f, %.5f", latitude, longitude)
            if let accuracy = record.number("accuracyMeters") {
                value += "\n" + L.format("record.accuracy", accuracy.formatted(.number.precision(.fractionLength(0))))
            }
            result.append((L.text("record.coordinate"), value))
        }
        if let text = record.text, record.type == "clipboard.item" { result.append((L.text("record.text"), text)) }
        return result
    }
}

struct SenseRetentionView: View {
    let model: SensesModel
    let item: SenseItem
    let retention: PerceptionRetentionSetting
    @State private var text: String
    @Environment(\.dismiss) private var dismiss

    init(model: SensesModel, item: SenseItem, retention: PerceptionRetentionSetting) {
        self.model = model
        self.item = item
        self.retention = retention
        _text = State(initialValue: String(retention.days))
    }

    private var value: Int? { Int(text.trimmingCharacters(in: .whitespaces)) }

    private var valid: Bool { value.map(retention.accepts) ?? false }

    var body: some View {
        SenseSheet(title: L.text("detail.\(item.retentionLabel)"), back: { dismiss() }) {
            VStack(alignment: .leading, spacing: DesignTokens.Senses.listGap) {
                GroupedSection {
                    HStack(spacing: DesignTokens.Size.rowGap) {
                        TextField("", text: $text)
                            .hmType(DesignTokens.TypeScale.body)
                            .senseNumberKeyboard()
                        Text(L.text("detail.daysUnit"))
                            .hmType(DesignTokens.TypeScale.body)
                            .foregroundStyle(Color.hmMuted)
                    }
                    .frame(minHeight: DesignTokens.Size.rowMinHeight)
                }
                Text(rangeNote)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                    .padding(.horizontal, DesignTokens.Senses.footnotePaddingX)
                Spacer()
                Button {
                    guard let value else { return }
                    Task {
                        await model.setRetention(item, days: value)
                        dismiss()
                    }
                } label: {
                    Text(L.text("detail.save"))
                }
                .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig))
                .disabled(!valid || value == retention.days)
                .padding(.bottom, DesignTokens.Size.sheetPaddingBottom)
            }
        }
    }

    private var rangeNote: String {
        var note = L.format("detail.defaultDays", retention.defaultDays)
        if let maxDays = retention.maxDays {
            note += " " + L.format("detail.range", retention.minDays ?? 1, maxDays)
        }
        return note
    }
}

extension SenseItem {
    var retentionLabel: String {
        retentionKey == "track" ? "track" : "kept"
    }
}

extension View {
    @ViewBuilder
    func senseNumberKeyboard() -> some View {
        #if os(iOS)
        keyboardType(.numberPad)
        #else
        self
        #endif
    }
}
