import HimawariCore
import HimawariDesign
import SwiftUI

struct AgentGrantSheet: View {
    let store: AgentsStore
    let grant: AgentGrant
    let done: () -> Void
    @State private var choice: AgentGrantChoice
    @State private var failed = false

    init(store: AgentsStore, grant: AgentGrant, done: @escaping () -> Void) {
        self.store = store
        self.grant = grant
        self.done = done
        _choice = State(initialValue: store.choice(for: grant))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(grant.clientName).font(.headline)
                        Text(M.agentGrantFrom(grant.clientHost)).font(.subheadline).foregroundStyle(.secondary)
                        Text(grant.localRedirect ? M.agentGrantLocal : M.agentGrantReturnsTo(grant.redirectHost))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if let existing = grant.existingConnection {
                            Text(M.agentGrantReplaces(existing.name)).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    TextField(M.agentGrantName, text: Binding(
                        get: { choice.name },
                        set: { choice.name = String($0.prefix(AgentsStore.nameCharacters)) }
                    ))
                    Picker(M.agentCeilingLabel, selection: $choice.readCeiling) {
                        ForEach(AgentReadCeiling.allCases) { Text(M.agentCeiling($0)).tag($0) }
                    }
                    if grant.wantsWrite {
                        Toggle(M.agentGrantWrite, isOn: $choice.write)
                    }
                    if choice.write {
                        Picker(M.agentPushLabel, selection: $choice.pushPolicy) {
                            ForEach(AgentPushPolicy.allCases) { Text(M.agentPush($0)).tag($0) }
                        }
                    }
                }
                Section {
                    Button(action: approve) {
                        HStack(spacing: SL.rowGap) {
                            if store.working { ProgressView() }
                            Text(M.agentGrantApprove)
                        }
                        .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.pill)
                    }
                    .buttonStyle(.borderedProminent)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    Button(role: .destructive, action: deny) {
                        Text(M.agentGrantDeny).frame(maxWidth: .infinity, minHeight: DesignTokens.Size.pill)
                    }
                    .buttonStyle(.bordered)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
                .disabled(store.working)
            }
            .timersListStyle()
            .navigationTitle(M.agentGrantTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(M.done, action: done)
                }
            }
        }
        .alert(M.agentGrantFailed, isPresented: $failed) {
            Button(M.done, action: done)
        }
        .interactiveDismissDisabled(store.working)
    }

    private func approve() {
        Task {
            do {
                try await store.approve(grant, choice)
                done()
            } catch {
                failed = true
            }
        }
    }

    private func deny() {
        Task {
            do {
                try await store.deny(grant)
                done()
            } catch {
                failed = true
            }
        }
    }
}

public struct AgentGrantPrompt: ViewModifier {
    @State private var store: AgentsStore
    @State private var shown: AgentGrant?
    @State private var closed: Set<String> = []
    @Environment(\.scenePhase) private var scenePhase
    private let requested: Bool
    private let handled: () -> Void

    public init(api: DeviceAPI, confirmKey: DeviceKeySigner, requested: Bool, handled: @escaping () -> Void) {
        _store = State(initialValue: AgentsStore(gateway: ManageGateway(transport: SignedDeviceTransport(http: api.http, confirmKey: confirmKey))))
        self.requested = requested
        self.handled = handled
    }

    public func body(content: Content) -> some View {
        content
            .task { await refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await refresh() } }
            }
            .onChange(of: requested, initial: true) { _, now in
                guard now else { return }
                handled()
                closed.removeAll()
                Task { await refresh() }
            }
            .sheet(item: $shown) { grant in
                AgentGrantSheet(store: store, grant: grant) {
                    closed.insert(grant.id)
                    shown = nil
                }
                    .presentationDetents([.large])
            }
    }

    private func refresh() async {
        guard shown == nil else { return }
        await store.loadGrants()
        shown = store.grants.first { grant in
            !closed.contains(grant.id) && (Timestamp.parse(grant.expiresAt).map { $0 > Date() } ?? true)
        }
    }
}

extension View {
    public func agentGrantPrompt(api: DeviceAPI, confirmKey: DeviceKeySigner, requested: Bool, handled: @escaping () -> Void) -> some View {
        modifier(AgentGrantPrompt(api: api, confirmKey: confirmKey, requested: requested, handled: handled))
    }
}
