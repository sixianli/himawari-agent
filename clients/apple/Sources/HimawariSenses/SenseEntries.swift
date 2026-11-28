import HimawariCore
import HimawariDesign
import SwiftUI

public struct SenseEntryLabel: View {
    private let model: SensesModel
    private let item: SenseItem

    public init(model: SensesModel, item: SenseItem) {
        self.model = model
        self.item = item
    }

    public var body: some View {
        let state = model.state(item)
        LabeledContent {
            Text(state.label)
        } label: {
            Label {
                Text(item.name)
            } icon: {
                Icon(item.icon, size: DesignTokens.IconSize.listRow)
                    .foregroundStyle(Color.hmGlyph)
            }
        }
    }
}

public struct SenseEntryScreen: View {
    private let model: SensesModel
    private let item: SenseItem
    private let back: () -> Void

    public init(model: SensesModel, item: SenseItem, back: @escaping () -> Void) {
        self.model = model
        self.item = item
        self.back = back
    }

    public var body: some View {
        SenseItemScreen(model: model, item: item, back: back)
            .alert(model.notice ?? "", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
                Button(L.text("detail.ok")) { model.notice = nil }
            }
    }
}

public struct SenseHandoverSection<Rows: View>: View {
    private let rows: Rows

    public init(@ViewBuilder rows: () -> Rows) {
        self.rows = rows()
    }

    public var body: some View {
        Section(L.text("senses.handedOver")) {
            rows
        }
    }
}

extension SensesModel {
    public func opens(_ item: SenseItem) -> Bool {
        state(item) != .serverUnsupported
    }
}
