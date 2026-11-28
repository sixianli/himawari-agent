import HimawariDesign
import SwiftUI

struct AgentsPage: View {
    let store: AgentsStore
    let open: (String) -> Void
    let back: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: M.agentsTitle, leading: .back, action: back)
            List {
                Section {
                    if store.phase == .unavailable, store.shown.isEmpty {
                        Text(M.loadFailed).foregroundStyle(.secondary)
                    } else if store.phase == .loaded, store.shown.isEmpty {
                        Text(M.agentsEmpty).foregroundStyle(.secondary)
                    }
                    ForEach(store.shown) { agent in
                        Button { open(agent.id) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(agent.name).foregroundStyle(.primary)
                                    Text(AgentsPage.summary(agent)).font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 0)
                                Icon(.chevronRight, size: DesignTokens.IconSize.chevron).foregroundStyle(Color.hmMuted)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.pressable)
                    }
                } footer: {
                    Text(M.agentsLead)
                }
            }
            .scrollContentBackground(.hidden)
            .timersListStyle()
            .refreshable { await store.load() }
        }
        .himawariScreenBackground()
        .task { await store.load() }
    }

    static func summary(_ agent: ConnectedAgent) -> String {
        var parts: [String] = []
        if agent.status != .active { parts.append(M.agentStatus(agent.status)) }
        if let host = agent.clientHost { parts.append(host) }
        parts.append(agent.lastSeenAt.flatMap(Timestamp.parse).map { M.agentLastSeen(M.relative($0)) } ?? M.agentNeverSeen)
        return parts.joined(separator: " · ")
    }
}

struct AgentPage: View {
    let store: AgentsStore
    let agentId: String
    let back: () -> Void
    @State private var revoking = false
    @State private var failed = false

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(title: store.agent(agentId)?.name ?? M.agentsTitle, leading: .back, action: back)
            if let agent = store.agent(agentId), agent.status != .revoked {
                List {
                    Section {
                        Picker(M.agentPushLabel, selection: binding(agent, \.pushPolicy) { try await store.change(agent, pushPolicy: $0) }) {
                            ForEach(AgentPushPolicy.allCases) { Text(M.agentPush($0)).tag($0) }
                        }
                        Toggle(M.agentPaused, isOn: Binding(
                            get: { agent.status == .paused },
                            set: { paused in run { try await store.change(agent, status: paused ? .paused : .active) } }
                        ))
                    } footer: {
                        Text([
                            agent.clientHost,
                            agent.lastSeenAt.flatMap(Timestamp.parse).map { M.agentLastSeen(M.relative($0)) } ?? M.agentNeverSeen,
                            M.agentPushes(agent.usage.memoryPushes),
                        ].compactMap { $0 }.joined(separator: " · "))
                    }
                    .disabled(store.working)
                    Section {
                        Button(M.agentRevoke, role: .destructive) { revoking = true }
                            .disabled(store.working)
                    }
                }
                .scrollContentBackground(.hidden)
                .timersListStyle()
                .refreshable { await store.load() }
            } else if store.phase == .loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(maxHeight: .infinity)
            }
        }
        .himawariScreenBackground()
        .confirmationDialog(M.agentRevoke, isPresented: $revoking, titleVisibility: .visible) {
            Button(M.agentRevoke, role: .destructive) {
                guard let agent = store.agent(agentId) else { return }
                run {
                    try await store.change(agent, status: .revoked)
                    back()
                }
            }
        } message: {
            Text(M.agentRevokeDetail)
        }
        .alert(M.agentChangeFailed, isPresented: $failed) {}
    }

    private func binding<Value: Equatable>(
        _ agent: ConnectedAgent,
        _ key: KeyPath<ConnectedAgent, Value>,
        change: @escaping @MainActor (Value) async throws -> Void
    ) -> Binding<Value> {
        Binding(
            get: { agent[keyPath: key] },
            set: { value in
                guard value != agent[keyPath: key] else { return }
                run { try await change(value) }
            }
        )
    }

    private func run(_ work: @escaping @MainActor () async throws -> Void) {
        Task {
            do {
                try await work()
            } catch {
                failed = true
            }
        }
    }
}
