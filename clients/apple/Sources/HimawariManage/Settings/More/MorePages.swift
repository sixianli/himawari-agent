import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

enum MorePage: Hashable {
    case personalization
    case search
    case pushKinds
    case mcp
    case mcpDetail(String)
    case sensitive
    case muse
}

struct MorePageView: View {
    let page: MorePage
    let store: MoreSettingsStore
    let open: (MorePage) -> Void
    let back: () -> Void

    var body: some View {
        switch page {
        case .personalization: PersonalizationPage(store: store, back: back)
        case .search: SearchAuthorizationPage(store: store, back: back)
        case .pushKinds: PushKindsPage(store: store, back: back)
        case .mcp: McpListPage(store: store, open: { open(.mcpDetail($0)) }, back: back)
        case .mcpDetail(let id): McpDetailPage(store: store, connectionId: id, back: back)
        case .sensitive: SensitiveRecordsPage(store: store, back: back)
        case .muse: MusePage(store: store, back: back)
        }
    }
}

struct MoreEntryGroups: View {
    let store: MoreSettingsStore
    let open: (MorePage) -> Void

    private struct Entry {
        let page: MorePage
        let icon: IconName
        let title: String
        let value: String?
    }

    private var yours: [Entry] {
        var entries: [Entry] = []
        if store.preferences != nil {
            entries.append(Entry(page: .personalization, icon: .user, title: M.personalizationTitle, value: nil))
        }
        if let search = store.search {
            entries.append(Entry(page: .search, icon: .search, title: M.searchTitle, value: search.enabled ? M.on : M.off))
        }
        if store.push != nil {
            entries.append(Entry(page: .pushKinds, icon: .bell, title: M.pushKindsTitle, value: nil))
        }
        return entries
    }

    private var connected: [Entry] {
        var entries: [Entry] = []
        if let mcp = store.mcp {
            entries.append(Entry(page: .mcp, icon: .affiliate, title: M.mcpTitle, value: mcp.live.isEmpty ? nil : "\(mcp.live.count)"))
        }
        if let counts = store.sensitiveCounts {
            entries.append(Entry(page: .sensitive, icon: .shieldLock, title: M.sensitiveTitle, value: counts.total == 0 ? nil : "\(counts.total)"))
        }
        if let muse = store.muse {
            entries.append(Entry(page: .muse, icon: .listCheck, title: M.museTitle, value: muse.pending == 0 ? nil : "\(muse.pending)"))
        }
        return entries
    }

    var body: some View {
        group(M.moreYouGroup, yours)
        group(M.moreConnectedGroup, connected)
    }

    @ViewBuilder
    private func group(_ label: String, _ entries: [Entry]) -> some View {
        if !entries.isEmpty {
            SettingsGroup(label: label) {
                ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                    Button { open(entry.page) } label: {
                        SettingsRow(icon: entry.icon, title: entry.title, value: entry.value, chevron: true, last: index == entries.count - 1)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

@MainActor
func runMoreAction(failed: Binding<Bool>, _ work: @escaping @MainActor () async throws -> Void) {
    runMoreAction(failed: failed, onConflict: { failed.wrappedValue = true }, work)
}

@MainActor
func runMoreAction(
    failed: Binding<Bool>,
    onConflict: @escaping @MainActor () async -> Void,
    _ work: @escaping @MainActor () async throws -> Void
) {
    Task {
        do {
            try await work()
        } catch where SettingsStore.isDeclined(error) {
        } catch ManageGatewayError.rejected(409, _, _) {
            await onConflict()
        } catch {
            failed.wrappedValue = true
        }
    }
}

struct ChoiceRow: View {
    let title: String
    let selected: Bool
    var last = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                Text(title).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if selected {
                    Icon(.check, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmText)
                }
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if !last { RowSeparator() }
        }
        .contentShape(Rectangle())
    }
}

struct MoreNote: View {
    let text: String
    var warning = false

    init(_ text: String, warning: Bool = false) {
        self.text = text
        self.warning = warning
    }

    var body: some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(warning ? Color.hmDanger : Color.hmMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, SL.groupLabelPadding)
    }
}
