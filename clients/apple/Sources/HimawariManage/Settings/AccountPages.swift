import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct LoginDevicesPage: View {
    let store: SettingsStore
    let back: () -> Void
    @State private var failed = false
    @State private var stillChanging = false

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.loginBrowsers, leading: .back, action: back)
            let devices = store.loginDevices ?? []
            if devices.isEmpty {
                EmptyStateView(Text(store.loginDevices == nil ? M.loadFailed : M.noLoginBrowsers))
                    .frame(minHeight: DesignTokens.Size.emptyMinHeight)
            } else {
                SettingsGroup(label: nil) {
                    ForEach(Array(devices.enumerated()), id: \.element.id) { index, device in
                        LoginDeviceRow(device: device, last: index == devices.count - 1) { signOut(device) }
                    }
                }
                if devices.contains(where: { !$0.current }) {
                    Button(action: signOutOthers) {
                        Text(M.signOutOthers).hmType(SL.rowValue).foregroundStyle(Color.hmSun)
                            .frame(minHeight: DesignTokens.Size.minTapTarget)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, SL.groupLabelPadding)
                }
                if stillChanging {
                    Text(M.loginStillChanging).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                }
            }
        }
        .task { await store.reloadLoginDevices() }
        .refreshable { await store.reloadLoginDevices() }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func signOutOthers() {
        stillChanging = false
        Task {
            do {
                stillChanging = try await store.signOutOthers(reason: M.confirmSignOutOthers) == .stillChanging
            } catch {
                failed = true
            }
        }
    }

    private func signOut(_ device: LoginDevice) {
        stillChanging = false
        Task {
            do {
                try await store.signOut(device, reason: M.confirmSignOut(device.label))
            } catch {
                failed = true
            }
        }
    }
}

struct LoginDeviceRow: View {
    let device: LoginDevice
    let last: Bool
    let signOut: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: SL.rowGap) {
                Icon(.world, size: DesignTokens.IconSize.listRow).foregroundStyle(Color.hmText)
                VStack(alignment: .leading, spacing: SL.rowTextGap) {
                    Text(device.label).hmType(SL.rowValue).foregroundStyle(Color.hmText)
                    Text(M.loginSeen(device)).hmType(DesignTokens.TypeScale.caption).foregroundStyle(Color.hmMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !device.current {
                    Button(action: signOut) {
                        Text(M.signOut).hmType(SL.rowValue).foregroundStyle(Color.hmSun)
                            .frame(minHeight: DesignTokens.Size.minTapTarget)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, SL.rowPaddingVertical)
            .frame(minHeight: SL.rowMinHeight)
            if !last { RowSeparator() }
        }
    }
}

struct StoredFilesPage: View {
    let store: SettingsStore
    let back: () -> Void
    @State private var origin: FileOrigin = .generated

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.files, leading: .back, action: back)
            SegmentPicker(selection: $origin, options: FileOrigin.allCases.map { ($0, M.fileOrigin($0)) })
            let shelf = store.shelf(origin)
            if !shelf.loaded {
                ProgressView().frame(maxWidth: .infinity, minHeight: DesignTokens.Size.emptyMinHeight)
            } else if shelf.failed {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            } else if shelf.files.isEmpty {
                EmptyStateView(Text(M.noFiles(origin))).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            } else {
                SettingsGroup(label: nil) {
                    ForEach(Array(shelf.files.enumerated()), id: \.element.id) { index, file in
                        SettingsRow(
                            icon: file.icon,
                            title: file.name,
                            detail: Timestamp.parse(file.createdAt).map { M.fileLine(day: $0, thread: file.threadTitle) },
                            last: index == shelf.files.count - 1
                        )
                        .onAppear {
                            if index == shelf.files.count - 1 { Task { await store.loadFiles(origin, more: true) } }
                        }
                    }
                }
            }
        }
        .task(id: origin) {
            if !store.shelf(origin).loaded { await store.loadFiles(origin) }
        }
        .refreshable { await store.loadFiles(origin) }
    }
}

extension StoredFile {
    var icon: IconName {
        switch kind {
        case "image": .photo
        case "code": .terminal2
        case "web": .world
        case "data": .table
        default: .fileText
        }
    }
}

struct SegmentPicker<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(Value, String)]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.0) { value, title in
                option(value, title)
            }
        }
        .padding(ManageLayout.Segment.inset)
        .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.segment, style: .continuous))
    }

    private func option(_ value: Value, _ title: String) -> some View {
        Button {
            selection = value
        } label: {
            Text(title)
                .hmType(selection == value ? DesignTokens.TypeScale.navTitle : DesignTokens.TypeScale.body)
                .foregroundStyle(Color.hmText)
                .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.minTapTarget)
                .background {
                    if selection == value {
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.segment - ManageLayout.Segment.inset, style: .continuous)
                            .fill(Color.hmSurface)
                            .hmShadow(DesignTokens.Shadows.lift)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == value ? .isSelected : [])
    }
}
