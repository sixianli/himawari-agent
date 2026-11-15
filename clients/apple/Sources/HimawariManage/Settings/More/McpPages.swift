import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

private func usageLine(_ usage: McpUsage) -> String {
    [M.mcpReads(usage.reads), M.mcpDelivered(usage.delivered), M.mcpEmptyReads(usage.empty), M.mcpFailed(usage.failed)]
        .joined(separator: " · ")
}

private func seenLine(_ connection: McpConnection) -> String {
    [M.mcpLastSeen(connection.lastSeenAt), connection.reportedClient.map(M.mcpReported)]
        .compactMap { $0 }
        .joined(separator: " · ")
}

struct McpListPage: View {
    let store: MoreSettingsStore
    let open: (String) -> Void
    let back: () -> Void

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.mcpTitle, leading: .back, action: back)
            if let list = store.mcp {
                MoreNote(M.mcpIntro)
                if list.connections.isEmpty {
                    EmptyStateView(Text(M.mcpEmpty)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                } else {
                    MoreNote(M.mcpWindow(list.window))
                    if !list.live.isEmpty {
                        SettingsGroup(label: nil) {
                            ForEach(Array(list.live.enumerated()), id: \.element.id) { index, connection in
                                Button { open(connection.id) } label: {
                                    SettingsRow(
                                        icon: nil,
                                        title: connection.name,
                                        detail: seenLine(connection),
                                        note: usageLine(connection.usage),
                                        value: connection.isPaused ? M.mcpStatus(connection.status) : nil,
                                        chevron: true,
                                        last: index == list.live.count - 1
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    if !list.gone.isEmpty {
                        SettingsGroup(label: M.mcpRevokedGroup) {
                            ForEach(Array(list.gone.enumerated()), id: \.element.id) { index, connection in
                                Button { open(connection.id) } label: {
                                    SettingsRow(icon: nil, title: connection.name, chevron: true, last: index == list.gone.count - 1)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    MoreNote(M.mcpDefinitionsTitle + "：" + M.mcpDefinitions)
                }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.loadMcp() }
        .refreshable { await store.loadMcp() }
    }
}

struct McpDetailPage: View {
    let store: MoreSettingsStore
    let connectionId: String
    let back: () -> Void
    @State private var failed = false
    @State private var busy = false
    @State private var renaming = false
    @State private var draftName = ""
    @State private var revoking = false

    private var connection: McpConnection? { store.mcp?.connection(connectionId) }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            if let connection {
                SheetHeader(title: connection.name, leading: .back, action: back)
                MoreNote(M.mcpStatus(connection.status) + " · " + seenLine(connection))
                if !connection.isRevoked {
                    SettingsGroup(label: M.mcpCeiling) {
                        ForEach(Array(McpConnections.ceilings.enumerated()), id: \.element) { index, ceiling in
                            Button { apply(connection, connection.ceiling(ceiling)) } label: {
                                ChoiceRow(
                                    title: M.mcpCeilingName(ceiling),
                                    selected: connection.readCeiling == ceiling,
                                    last: index == McpConnections.ceilings.count - 1
                                )
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                        }
                    }
                }
                SettingsGroup(label: store.mcp.map { M.mcpWindow($0.window) }) {
                    SettingsRow(icon: nil, title: M.mcpReads(connection.usage.reads))
                    SettingsRow(icon: nil, title: M.mcpDelivered(connection.usage.delivered))
                    SettingsRow(icon: nil, title: M.mcpEmptyReads(connection.usage.empty))
                    SettingsRow(icon: nil, title: M.mcpFailed(connection.usage.failed), last: true)
                }
                MoreNote(M.mcpDefinitions)
                if !connection.isRevoked {
                    VStack(spacing: PL.buttonGap) {
                        Button {
                            draftName = connection.name
                            renaming = true
                        } label: { Text(M.mcpRename) }
                            .buttonStyle(CapsuleButtonStyle(.secondary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        Button {
                            apply(connection, connection.moving(to: connection.isPaused ? McpConnections.active : McpConnections.paused))
                        } label: { Text(connection.isPaused ? M.mcpResume : M.mcpPause) }
                            .buttonStyle(CapsuleButtonStyle(.secondary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                        Button { revoking = true } label: {
                            Text(M.mcpRevoke).hmType(SL.rowValue).foregroundStyle(Color.hmDanger)
                                .frame(minHeight: DesignTokens.Size.minTapTarget)
                        }
                        .buttonStyle(.plain)
                    }
                    .disabled(busy)
                }
            } else {
                SheetHeader(title: M.mcpTitle, leading: .back, action: back)
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.loadMcp() }
        .refreshable { await store.loadMcp() }
        .alert(M.mcpRename, isPresented: $renaming) {
            TextField(M.mcpName, text: $draftName)
            Button(M.cancel, role: .cancel) {}
            Button(M.ok) {
                if let connection { apply(connection, connection.renamed(draftName)) }
            }
        }
        .confirmationDialog(M.mcpRevokeAsk, isPresented: $revoking, titleVisibility: .visible) {
            Button(M.mcpRevoke, role: .destructive) {
                if let connection { apply(connection, connection.moving(to: McpConnections.revoked)) }
            }
            Button(M.cancel, role: .cancel) {}
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func apply(_ connection: McpConnection, _ change: McpConnectionChange?) {
        guard let change, !busy else { return }
        busy = true
        runMoreAction(
            failed: $failed,
            onConflict: {
                await store.loadMcp()
                busy = false
                failed = true
            }
        ) {
            defer { busy = false }
            try await store.changeMcp(change, reason: M.confirmMcp(connection.name))
            await store.loadMcp()
        }
    }
}
