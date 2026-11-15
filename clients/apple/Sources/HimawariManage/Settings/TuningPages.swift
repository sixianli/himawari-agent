import HimawariCore
import HimawariDesign
import SwiftUI

typealias TL = ManageLayout.TuningSheet

struct TuningListPage: View {
    let store: SettingsStore
    let kind: TuningKind
    let open: (String) -> Void
    let back: () -> Void

    private var title: String { kind == .think ? M.thinkTitle : M.notificationsTitle }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: title, leading: .back, action: back)
            if let snapshot = store.tuning[kind] {
                if !snapshot.isEnabled {
                    Text(M.tuningDisabled).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                }
                SettingsGroup(label: kind == .delivery ? M.deliveryGroup : nil) {
                    ForEach(Array(snapshot.items.enumerated()), id: \.element.id) { index, item in
                        let copy = M.tuningCopy(kind, key: item.key, serverUnit: item.unit)
                        Button { open(item.key) } label: {
                            SettingsRow(
                                icon: nil,
                                title: copy.name,
                                note: copy.note.isEmpty ? nil : copy.note,
                                value: valueText(item, copy: copy),
                                chevron: snapshot.isEnabled,
                                last: index == snapshot.items.count - 1
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(!snapshot.isEnabled)
                    }
                }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.reloadTuning(kind) }
        .refreshable { await store.reloadTuning(kind) }
    }

    private func valueText(_ item: TuningItem, copy: M.TuningCopy) -> String {
        item.isSwitch ? (item.value == 1 ? M.on : M.off) : "\(item.value)" + (copy.unit.map { " \($0)" } ?? "")
    }
}

struct TuningEditPage: View {
    let store: SettingsStore
    let kind: TuningKind
    let key: String
    let back: () -> Void
    @State private var draft: Int?
    @State private var failed = false
    @State private var busy = false

    private var item: TuningItem? { store.tuning[kind]?.items.first { $0.key == key } }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            if let item {
                let copy = M.tuningCopy(kind, key: key, serverUnit: item.unit)
                let current = draft ?? item.value
                SheetHeader(title: copy.name, leading: .back, action: back)
                if !copy.note.isEmpty {
                    Text(copy.note).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(spacing: TL.gap) {
                    if item.isSwitch {
                        Toggle("", isOn: Binding(get: { current == 1 }, set: { draft = $0 ? 1 : 0 }))
                            .labelsHidden().tint(Color.hmSuccess)
                    } else {
                        Text("\(current)" + (copy.unit.map { " \($0)" } ?? ""))
                            .hmType(TL.value).foregroundStyle(Color.hmText)
                        Stepper("", value: Binding(get: { current }, set: { draft = $0 }), in: item.minimum...item.maximum, step: item.step)
                            .labelsHidden()
                    }
                    Text(M.tuningDefault(item.defaultValue, unit: item.isSwitch ? nil : copy.unit))
                        .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    if failed {
                        Text(M.tuningSaveFailed).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmDanger)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, TL.gap)
                Spacer(minLength: DL.askTopPadding)
                VStack(spacing: ManageLayout.ExportSheet.buttonGap) {
                    Button { save(item, copy.name, current) } label: { Text(M.tuningSave) }
                        .buttonStyle(CapsuleButtonStyle(.primary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        .disabled(busy || current == item.value)
                    Button { save(item, copy.name, nil) } label: { Text(M.tuningRestore) }
                        .buttonStyle(CapsuleButtonStyle(.secondary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        .disabled(busy || !item.overridden)
                }
            } else {
                SheetHeader(title: M.notificationsTitle, leading: .back, action: back)
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
    }

    private func save(_ item: TuningItem, _ name: String, _ value: Int?) {
        failed = false
        busy = true
        Task {
            defer { busy = false }
            do {
                try await store.changeTuning(kind, key: key, value: value, reason: M.confirmTuning(name))
                draft = nil
            } catch where SettingsStore.isDeclined(error) {
            } catch {
                draft = nil
                failed = true
            }
        }
    }
}
