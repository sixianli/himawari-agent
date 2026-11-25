import HimawariDesign
import SwiftUI

struct MemoryDetailSheet: View {
    typealias L = ManageLayout.DetailSheet

    let item: MemoryItem
    let basis: String
    let lastUsed: String
    let versions: [MemoryItem.History]
    let useVersion: (Int) -> Void
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
            if !versions.isEmpty {
                VStack(alignment: .leading, spacing: L.fieldGap) {
                    Text(M.previousVersions).hmType(L.fieldLabel).foregroundStyle(Color.hmMuted)
                    VStack(spacing: 0) {
                        ForEach(Array(versions.enumerated()), id: \.element.historyId) { index, version in
                            versionRow(version)
                            if index < versions.count - 1 { RowSeparator() }
                        }
                    }
                    .padding(.horizontal, L.fieldPaddingHorizontal)
                    .himawariCard(padding: EdgeInsets())
                }
            }
            Text(M.deleteNote)
                .hmType(DesignTokens.TypeScale.caption)
                .foregroundStyle(Color.hmMuted)
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

    private func versionRow(_ version: MemoryItem.History) -> some View {
        HStack(spacing: L.titleGap) {
            VStack(alignment: .leading, spacing: L.fieldGap) {
                Text(version.text).hmType(L.fieldValue).foregroundStyle(Color.hmText)
                if let date = Timestamp.parse(version.at) {
                    Text(M.pairedDay(date)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { useVersion(version.historyId) } label: {
                Text(M.useThisVersion)
                    .hmType(DesignTokens.TypeScale.rowAction)
                    .foregroundStyle(Color.hmText)
                    .frame(minHeight: DesignTokens.Size.minTapTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, L.fieldPaddingVertical)
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
