import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

struct PersonalizationPage: View {
    let store: MoreSettingsStore
    let back: () -> Void
    @State private var name = ""
    @State private var locale: OwnerLocale?
    @State private var failed = false
    @State private var busy = false
    @State private var notice: String?
    @State private var seeded = false
    @FocusState private var typing: Bool

    private var change: OwnerPreferencesChange? {
        store.preferences?.change(name: name, locale: locale)
    }

    var body: some View {
        SettingsPage(gap: SL.pageGap) {
            SheetHeader(title: M.personalizationTitle, leading: .back, action: back)
            if store.preferences != nil {
                VStack(alignment: .leading, spacing: SL.groupGap) {
                    Text(M.personalName)
                        .hmType(DesignTokens.TypeScale.groupLabel)
                        .foregroundStyle(Color.hmMuted)
                        .padding(.horizontal, SL.groupLabelPadding)
                    TextField(M.personalNameHint, text: $name)
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmText)
                        .focused($typing)
                        .submitLabel(.done)
                        .onSubmit { typing = false }
                        .onChange(of: name) { _, value in
                            let clamped = OwnerPreferences.clampedName(value)
                            if clamped != value { name = clamped }
                        }
                        .frame(minHeight: DesignTokens.Size.minTapTarget)
                        .himawariCard()
                }
                SettingsGroup(label: M.localeTitle) {
                    ForEach(Array(OwnerLocale.allCases.enumerated()), id: \.element) { index, option in
                        Button { locale = option } label: {
                            ChoiceRow(title: M.localeName(option), selected: locale == option, last: index == OwnerLocale.allCases.count - 1)
                        }
                        .buttonStyle(.plain)
                    }
                }
                MoreNote(M.localeNote)
                if let notice { MoreNote(notice) }
                Button(action: save) { Text(M.save) }
                    .buttonStyle(CapsuleButtonStyle(.primary, height: TL.buttonHeight, fontSize: DesignTokens.TypeScale.body.size))
                    .disabled(busy || change == nil)
            } else {
                EmptyStateView(Text(M.loadFailed)).frame(minHeight: DesignTokens.Size.emptyMinHeight)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .task {
            await store.loadPreferences()
            if !seeded { seed() }
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private func seed() {
        guard let preferences = store.preferences else { return }
        name = preferences.name ?? ""
        locale = preferences.locale.flatMap(OwnerLocale.init(rawValue:))
        seeded = true
    }

    private func save() {
        typing = false
        notice = nil
        busy = true
        let draftName = name
        let draftLocale = locale
        runMoreAction(
            failed: $failed,
            onConflict: {
                await store.loadPreferences()
                seed()
                notice = M.preferencesStale
                busy = false
            }
        ) {
            defer { busy = false }
            try await store.savePreferences(name: draftName, locale: draftLocale, reason: M.confirmPersonalization)
            await store.loadPreferences()
            seed()
            notice = M.preferencesSaved
        }
    }
}
