import HimawariCore
import HimawariDesign
import SwiftUI

typealias TL = ManageLayout.TuningSheet

struct TuningListPage: View {
    let store: SettingsStore
    let kind: TuningKind
    let open: (String) -> Void
    let back: () -> Void

    private var title: String { M.thinkTitle }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: title, leading: .back, action: back)
            if let snapshot = store.tuning[kind] {
                if !snapshot.isEnabled {
                    Text(M.tuningDisabled).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                }
                SettingsGroup(label: nil) {
                    ForEach(Array(snapshot.shown.enumerated()), id: \.element.id) { index, item in
                        Button { open(item.key) } label: {
                            SettingsRow(
                                icon: nil,
                                title: item.name,
                                note: item.note.isEmpty ? nil : item.note,
                                value: valueText(item),
                                chevron: snapshot.isEnabled,
                                last: index == snapshot.shown.count - 1
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

    private func valueText(_ item: TuningItem) -> String {
        item.isSwitch ? (item.value == 1 ? M.on : M.off) : item.text(item.value)
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
                let current = draft ?? item.value
                SheetHeader(title: item.name, leading: .back, action: back)
                if !item.note.isEmpty {
                    Text(item.note).hmType(DesignTokens.TypeScale.secondary).foregroundStyle(Color.hmMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                VStack(spacing: TL.gap) {
                    if item.isSwitch {
                        Toggle("", isOn: Binding(get: { current == 1 }, set: { draft = $0 ? 1 : 0 }))
                            .labelsHidden().tint(Color.hmSuccess)
                    } else {
                        Text(item.text(current))
                            .hmType(TL.value).foregroundStyle(Color.hmText)
                        Stepper(
                            "",
                            onIncrement: { draft = item.stepUp(from: current) },
                            onDecrement: { draft = item.stepDown(from: current) }
                        )
                        .labelsHidden()
                    }
                    Text(M.tuningDefault(item.isSwitch ? "\(item.defaultValue)" : item.text(item.defaultValue)))
                        .hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                    if failed {
                        Text(M.tuningSaveFailed).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmDanger)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, TL.gap)
                Spacer(minLength: DL.askTopPadding)
                VStack(spacing: ManageLayout.ExportSheet.buttonGap) {
                    Button { save(item, item.name, current) } label: { Text(M.tuningSave) }
                        .buttonStyle(CapsuleButtonStyle(.primary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        .disabled(busy || current == item.value)
                    Button { save(item, item.name, nil) } label: { Text(M.tuningRestore) }
                        .buttonStyle(CapsuleButtonStyle(.secondary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        .disabled(busy || !item.overridden)
                }
            } else {
                SheetHeader(title: M.thinkTitle, leading: .back, action: back)
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
            } catch where Self.declined(error) {
            } catch {
                draft = nil
                failed = true
            }
        }
    }

    private static func declined(_ error: Error) -> Bool {
        !(error is ManageGatewayError || error is DeviceAPIError || error is DeviceKeyError || error is DecodingError || error is URLError || error is HTTPExchangeError)
    }
}
