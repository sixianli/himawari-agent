import HimawariCore
import HimawariDesign
import Observation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@MainActor
@Observable
final class HandoverEntryModel {
    private(set) var settings: HandoverSettings
    @ObservationIgnored private let store: LocalStore?

    init(store: LocalStore?) {
        self.store = store
        settings = store.map { HandoverSettings.load(from: $0) } ?? HandoverSettings()
    }

    convenience init(bundle: Bundle = .main) {
        self.init(store: try? SharedVault(bundle: bundle).handoverStore())
    }

    func isOn(_ entry: HandoverEntry) -> Bool { settings.isOn(entry) }

    func set(_ entry: HandoverEntry, on: Bool) {
        var next = settings
        next.set(entry, on: on)
        guard let store else { return }
        do {
            try next.save(to: store)
            settings = next
        } catch {
            settings = HandoverSettings.load(from: store)
        }
    }

    func reload() {
        guard let store else { return }
        settings = HandoverSettings.load(from: store)
    }
}

public enum ShareEntryStatus {
    case share
    case safari

    var entry: HandoverEntry { self == .share ? .share : .safari }

    @MainActor
    public var label: String {
        let settings = (try? SharedVault(bundle: .main).handoverStore()).map { HandoverSettings.load(from: $0) } ?? HandoverSettings()
        return Self.label(entry, settings.state(entry))
    }

    static func label(_ entry: HandoverEntry, _ state: HandoverEntryState) -> String {
        switch state {
        case .off: L.text("status.off")
        case .notSetUp: L.text("status.setUp")
        case .on: L.text(entry == .share ? "status.anytime" : "status.on")
        }
    }
}

struct EntryFact: View {
    let icon: IconName
    let key: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: DesignTokens.Size.rowGap) {
            Icon(icon, size: DesignTokens.IconSize.listRow)
                .foregroundStyle(Color.hmMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(key)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                Text(value)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct EntryHero: View {
    let icon: IconName
    let title: String

    var body: some View {
        VStack(spacing: DesignTokens.Handover.heroGap) {
            Icon(icon, size: DesignTokens.Handover.heroIcon)
                .foregroundStyle(Color.hmSun)
            Text(title)
                .font(.system(.title, weight: .semibold))
                .foregroundStyle(Color.hmText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, DesignTokens.Handover.heroTop)
    }
}

struct EntryNote: View {
    let text: String

    var body: some View {
        Text(text)
            .hmType(DesignTokens.TypeScale.caption)
            .foregroundStyle(Color.hmMuted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, DesignTokens.Handover.noteInset)
    }
}

struct EntrySteps: View {
    let steps: [(IconName, String, String)]

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Handover.stepsGap) {
            ForEach(steps.indices, id: \.self) { index in
                EntryFact(icon: steps[index].0, key: steps[index].1, value: steps[index].2)
            }
        }
        .himawariCard(padding: EdgeInsets(top: DesignTokens.Handover.stepsPadding, leading: DesignTokens.Handover.stepsPadding, bottom: DesignTokens.Handover.stepsPadding, trailing: DesignTokens.Handover.stepsPadding))
    }
}

public struct SafariEntryView: View {
    @State private var model: HandoverEntryModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    private let safariURL: URL?

    public init(safariURL: URL? = nil) {
        _model = State(initialValue: HandoverEntryModel())
        self.safariURL = safariURL
    }

    init(model: HandoverEntryModel) {
        _model = State(initialValue: model)
        safariURL = nil
    }

    private var steps: [(IconName, String, String)] {
        [
            (.number1, L.text("safari.step1.key"), L.text("safari.step1")),
            (.number2, L.text("safari.step2.key"), L.text("safari.step2")),
            (.number3, L.text("safari.step3.key"), L.text("safari.step3")),
        ]
    }

    public var body: some View {
        VStack(spacing: DesignTokens.Handover.pageGap) {
            if model.settings.state(.safari) == .notSetUp {
                EntryHero(icon: .brandSafariLarge, title: L.text("safari.hero"))
                EntrySteps(steps: steps)
                EntryNote(text: L.text("safari.note"))
                Spacer(minLength: 0)
                Button {
                    openURL(safariURL ?? URL(string: "https://")!)
                } label: {
                    Text(L.text("safari.open"))
                }
                .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.Handover.buttonFontSize))
            } else {
                GroupedSection {
                    ToggleRow(Text(L.text("safari.toggle")), isOn: Binding(get: { model.isOn(.safari) }, set: { model.set(.safari, on: $0) })) {
                        Icon(.brandSafari)
                    }
                }
                EntrySteps(steps: steps)
                EntryNote(text: L.text("entry.note"))
                Spacer(minLength: 0)
            }
        }
        .padding(EdgeInsets(top: DesignTokens.Size.sheetPaddingTop, leading: DesignTokens.Size.pagePaddingX, bottom: DesignTokens.Size.sheetPaddingBottom, trailing: DesignTokens.Size.pagePaddingX))
        .himawariScreenBackground()
        .entryTitle(L.text("entry.safari.title"))
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.reload() }
        }
    }
}

public struct ShareEntryView: View {
    @State private var model: HandoverEntryModel

    public init() {
        _model = State(initialValue: HandoverEntryModel())
    }

    init(model: HandoverEntryModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        VStack(spacing: DesignTokens.Handover.pageGap) {
            GroupedSection {
                ToggleRow(Text(L.text("share.toggle")), isOn: Binding(get: { model.isOn(.share) }, set: { model.set(.share, on: $0) })) {
                    Icon(.share2)
                }
            }
            EntrySteps(steps: [
                (.number1, L.text("share.step1.key"), L.text("share.step1")),
                (.number2, L.text("share.step2.key"), L.text("share.step2")),
                (.number3, L.text("share.step3.key"), L.text("share.step3")),
            ])
            EntryNote(text: L.text("entry.note"))
            Spacer(minLength: 0)
        }
        .padding(EdgeInsets(top: DesignTokens.Size.sheetPaddingTop, leading: DesignTokens.Size.pagePaddingX, bottom: DesignTokens.Size.sheetPaddingBottom, trailing: DesignTokens.Size.pagePaddingX))
        .himawariScreenBackground()
        .entryTitle(L.text("entry.share.title"))
    }
}

public struct HandoverEntryRoute: View {
    private let entry: HandoverEntry
    private let safariURL: URL?

    public init(_ entry: HandoverEntry, safariURL: URL? = nil) {
        self.entry = entry
        self.safariURL = safariURL
    }

    public var body: some View {
        switch entry {
        case .share: ShareEntryView()
        case .safari: SafariEntryView(safariURL: safariURL)
        }
    }
}

extension View {
    @ViewBuilder
    func entryTitle(_ title: String) -> some View {
        #if os(iOS)
        navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        #else
        navigationTitle(title)
        #endif
    }
}
