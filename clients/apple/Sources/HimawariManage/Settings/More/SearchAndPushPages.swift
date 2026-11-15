import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct SearchAuthorizationPage: View {
    let store: MoreSettingsStore
    let back: () -> Void
    @State private var pending: Bool?
    @State private var failed = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.searchTitle, leading: .back, action: back)
            if let search = store.search {
                SettingsGroup(label: nil) {
                    SettingsRow(
                        icon: nil,
                        title: M.searchAllow,
                        detail: search.enabled ? nil : (search.providersChanged ? M.searchProvidersChanged : M.searchOffNote),
                        switchState: Binding(
                            get: { pending ?? search.enabled },
                            set: { change(search, to: $0) }
                        ),
                        last: true
                    )
                    .disabled(!search.canSwitch || pending != nil)
                }
                if !search.canSwitch { MoreNote(M.searchNotConfigured) }
                if !search.recipientHosts.isEmpty {
                    SettingsGroup(label: M.searchSentTitle) {
                        ForEach(Array(search.recipientHosts.enumerated()), id: \.offset) { index, host in
                            SettingsRow(icon: nil, title: host, last: index == search.recipientHosts.count - 1)
                        }
                    }
                }
                MoreNote(M.searchSent)
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.loadSearch() }
        .refreshable { await store.loadSearch() }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func change(_ search: SearchAuthorization, to enabled: Bool) {
        guard search.setting(enabled: enabled) != nil else { return }
        pending = enabled
        runMoreAction(
            failed: $failed,
            onConflict: {
                await store.loadSearch()
                pending = nil
                failed = true
            }
        ) {
            defer { pending = nil }
            try await store.setSearch(enabled: enabled, reason: enabled ? M.confirmSearchOn : M.confirmSearchOff)
            await store.loadSearch()
        }
    }
}

struct PushKindsPage: View {
    let store: MoreSettingsStore
    let back: () -> Void
    @State private var pending: [String: Bool] = [:]
    @State private var failed = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.pushKindsTitle, leading: .back, action: back)
            if let push = store.push {
                if push.available {
                    SettingsGroup(label: nil) {
                        ForEach(Array(push.listedKinds.enumerated()), id: \.element) { index, kind in
                            SettingsRow(
                                icon: nil,
                                title: M.pushKind(kind),
                                detail: M.pushKindHint(kind),
                                switchState: Binding(
                                    get: { pending[kind] ?? push.isOn(kind) },
                                    set: { change(push, kind, to: $0) }
                                ),
                                last: index == push.listedKinds.count - 1
                            )
                            .disabled(pending[kind] != nil)
                        }
                    }
                    MoreNote(push.activeDeviceCount == 0 ? M.pushNoDevices : M.pushDevices(push.activeDeviceCount))
                } else {
                    EmptyStateView(Text(M.pushUnavailable)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
                }
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .task { await store.loadPush() }
        .refreshable { await store.loadPush() }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func change(_ push: PushStatus, _ kind: String, to enabled: Bool) {
        guard push.setting(kind, enabled: enabled) != nil else { return }
        pending[kind] = enabled
        runMoreAction(failed: $failed) {
            defer { pending[kind] = nil }
            try await store.setPushKind(kind, enabled: enabled, reason: M.confirmPushKind(kind))
            await store.loadPush()
        }
    }
}
