import HimawariDesign
import SwiftUI

struct MemoryDetailSheet: View {
    typealias L = ManageLayout.DetailSheet

    let item: MemoryItem
    let basis: String
    let lastUsed: String
    let close: () -> Void
    let delete: () -> Void
    let edit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: L.gap) {
            Capsule()
                .fill(Color.hmFillStrong)
                .frame(width: L.grabberWidth, height: L.grabberHeight)
                .frame(maxWidth: .infinity)
            HStack(alignment: .top, spacing: L.titleGap) {
                Text(item.text)
                    .hmType(L.title)
                    .foregroundStyle(Color.hmText)
                    .padding(.top, L.titleTopInset)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: close) {
                    Icon(.x, size: L.closeIcon)
                        .foregroundStyle(Color.hmText)
                        .frame(width: L.closeSize, height: L.closeSize)
                        .background(Color.hmFill, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(M.close))
            }
            VStack(spacing: 0) {
                field(M.howKnown, basis)
                RowSeparator()
                field(M.lastUsed, lastUsed)
            }
            .padding(.horizontal, L.fieldPaddingHorizontal)
            .himawariCard(padding: EdgeInsets())
            HStack {
                Button(action: delete) {
                    Text(M.delete)
                        .hmType(L.action)
                        .foregroundStyle(Color.hmDanger)
                        .padding(.horizontal, L.destructivePadding)
                        .frame(minHeight: L.actionHeight)
                }
                .buttonStyle(.plain)
                Spacer()
                Button(action: edit) {
                    Text(M.edit)
                        .hmType(L.action)
                        .foregroundStyle(Color.hmText)
                        .padding(.horizontal, L.actionPadding)
                        .frame(minHeight: L.actionHeight)
                        .background(Color.hmFill, in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, L.paddingTop)
        .padding(.horizontal, L.paddingHorizontal)
        .padding(.bottom, L.paddingBottom)
        .background(Color.hmBackground)
    }

    private func field(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: L.fieldGap) {
            Text(label).hmType(L.fieldLabel).foregroundStyle(Color.hmMuted)
            Text(value).hmType(L.fieldValue).foregroundStyle(Color.hmText)
        }
        .padding(.vertical, L.fieldPaddingVertical)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
