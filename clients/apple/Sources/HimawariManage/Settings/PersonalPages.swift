import HimawariCore
import HimawariDesign
import SwiftUI

struct NamePage: View {
    let store: PersonalStore
    let back: () -> Void
    @State private var draft: String
    @State private var saving = false
    @State private var failed = false
    @FocusState private var focused: Bool

    init(store: PersonalStore, back: @escaping () -> Void) {
        self.store = store
        self.back = back
        _draft = State(initialValue: store.name ?? "")
    }

    var body: some View {
        Form {
            Section {
                TextField(M.namePlaceholder, text: $draft)
                    #if os(iOS)
                    .textContentType(.nickname)
                    #endif
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(save)
                    .onChange(of: draft) { _, value in
                        if value.count > PersonalStore.nameLimit { draft = String(value.prefix(PersonalStore.nameLimit)) }
                    }
            } footer: {
                Text(M.nameFooter)
                    .foregroundStyle(Color.hmText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .scrollContentBackground(.hidden)
        .himawariScreenBackground()
        .navigationTitle(M.nameTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button(M.done, action: save)
                }
            }
        }
        .onAppear { focused = true }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private var changed: Bool {
        PersonalStore.cleanName(draft) != store.name
    }

    private func save() {
        guard !saving else { return }
        guard changed else { return back() }
        saving = true
        Task {
            defer { saving = false }
            do {
                try await store.setName(draft, reason: M.nameTitle)
                back()
            } catch {
                failed = true
            }
        }
    }
}

struct ModelPage: View {
    let store: PersonalStore
    let back: () -> Void
    @State private var modelRef: String
    @State private var thinkingLevel: String
    @State private var saving = false
    @State private var failed = false

    init(store: PersonalStore, back: @escaping () -> Void) {
        self.store = store
        self.back = back
        let model = store.chosenModel
        _modelRef = State(initialValue: model?.ref ?? "")
        _thinkingLevel = State(initialValue: model.flatMap(store.thinkingLevel(for:)) ?? "")
    }

    var body: some View {
        Form {
            if let models = store.models {
                Section {
                    Picker(M.modelTitle, selection: $modelRef) {
                        ForEach(models.options) { model in
                            ModelChoiceLabel(model: model).tag(model.ref)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                } footer: {
                    Text(models.options.contains { $0.priceTier != nil || $0.price != nil } ? M.modelFooter + "\n\n" + M.priceNote : M.modelFooter)
                        .foregroundStyle(Color.hmText)
                }
                if let model = selected, model.thinkingLevels.count > 1 {
                    Section {
                        Picker(M.thinkingTitle, selection: $thinkingLevel) {
                            ForEach(model.thinkingLevels, id: \.self) { level in
                                Text(M.thinkingLevel(level)).tag(level)
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } header: {
                        Text(M.thinkingTitle).foregroundStyle(Color.hmText)
                    } footer: {
                        Text(M.thinkingFooter).foregroundStyle(Color.hmText)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .himawariScreenBackground()
        .navigationTitle(M.modelTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button(M.done, action: save)
                }
            }
        }
        .onChange(of: modelRef) { _, _ in
            if let model = selected, !model.thinkingLevels.contains(thinkingLevel) {
                thinkingLevel = store.thinkingLevel(for: model) ?? ""
            }
        }
        .alert(M.actionFailed, isPresented: $failed) {}
    }

    private var selected: ChatModel? {
        store.models?.options.first { $0.ref == modelRef }
    }

    private var changed: Bool {
        guard let model = selected else { return false }
        let wasSaved = store.preferences?.modelRef != nil
        return !wasSaved || model.ref != store.chosenModel?.ref || thinkingLevel != store.thinkingLevel(for: model)
    }

    private func save() {
        guard !saving else { return }
        guard let model = selected, changed else { return back() }
        saving = true
        Task {
            defer { saving = false }
            do {
                try await store.setModel(model, thinkingLevel: thinkingLevel.isEmpty ? nil : thinkingLevel, reason: M.modelTitle)
                back()
            } catch {
                failed = true
            }
        }
    }
}

struct ModelChoiceLabel: View {
    let model: ChatModel

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(M.modelName(model))
                if let tier = model.priceTier {
                    Text(M.priceTier(tier))
                        .font(.caption)
                        .foregroundStyle(Color.hmText)
                }
            }
            if let detail = M.modelDetail(model) {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Color.hmText)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
