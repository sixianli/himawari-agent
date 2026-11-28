import HimawariCore
import HimawariDesign
import Observation
import SwiftUI

public enum HandoverSheetPhase: Equatable, Sendable {
    case editing
    case sending
    case finished(HandoverOutcome)
    case unpaired
    case unreadable
}

@MainActor
@Observable
public final class HandoverSheetModel {
    public var request = ""
    public private(set) var phase: HandoverSheetPhase
    public let entry: HandoverEntry
    public let content: HandoverContent?
    public let sourceApp: String?

    @ObservationIgnored private let desk: HandoverDesk?
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let locale: AnswerLocale
    @ObservationIgnored public var closeDelay: Duration = HandoverSheetPhase.closeDelay
    @ObservationIgnored public var onClose: () -> Void = {}
    @ObservationIgnored public var onOpen: (URL) -> Void = { _ in }

    public init(
        entry: HandoverEntry,
        content: HandoverContent?,
        sourceApp: String?,
        desk: HandoverDesk?,
        now: @escaping () -> Date = Date.init,
        locale: AnswerLocale = AnswerLocale.matching(preferredLanguages: Locale.preferredLanguages)
    ) {
        self.entry = entry
        self.content = content
        self.sourceApp = sourceApp
        self.desk = desk
        self.now = now
        self.locale = locale
        if desk == nil { phase = .unpaired }
        else if content == nil { phase = .unreadable }
        else { phase = .editing }
    }

    init(demo entry: HandoverEntry, content: HandoverContent?, request: String, phase: HandoverSheetPhase) {
        self.entry = entry
        self.content = content
        self.sourceApp = nil
        self.desk = nil
        self.now = Date.init
        self.locale = .chinese
        self.request = request
        self.phase = phase
    }

    public func submit() {
        guard phase == .editing, let desk, let content else { return }
        phase = .sending
        let handover = Handover(entry: entry, content: content, request: request, sourceApp: sourceApp, createdAt: now(), answerLocale: locale)
        Task {
            let outcome = await desk.hand(handover)
            phase = .finished(outcome)
            if phase.closesItself {
                try? await Task.sleep(for: closeDelay)
                onClose()
            }
        }
    }

    public func followUp() {
        if let url = phase.followUpURL(entry) { onOpen(url) } else { onClose() }
    }

    var cardTitle: String {
        switch content {
        case let .page(url, title, _), let .link(url, title):
            return title.flatMap { $0.isEmpty ? nil : $0 } ?? URL(string: url)?.host ?? url
        case let .text(text):
            return text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        case let .image(_, _, name):
            return name ?? L.text("sheet.image")
        case nil:
            return ""
        }
    }

    var cardSubtitle: String? {
        switch content {
        case .page:
            return content?.pageSubtitle(fullText: L.text("sheet.fullPage"), outcome: phase.outcome, paired: phase != .unpaired)
        case .link:
            return content?.host
        case .text:
            return sourceApp ?? L.text("sheet.text")
        case .image:
            return sourceApp ?? L.text("sheet.image")
        case nil:
            return nil
        }
    }

    var cardIcon: IconName {
        switch content {
        case .image: .photo
        case .text: .fileText
        default: .world
        }
    }

    var note: String {
        switch content {
        case .page, .link: L.text("sheet.note.page")
        default: L.text("sheet.note.other")
        }
    }

    var outcomeLine: String? { phase.line }

    var followUpTitle: String? { phase.followUpTitle }

    var isDone: Bool { phase.isDone }

    var sentRequest: String? {
        let trimmed = request.trimmingCharacters(in: .whitespacesAndNewlines)
        return isDone && !trimmed.isEmpty ? trimmed : nil
    }
}

extension HandoverSheetPhase {
    public static let closeDelay: Duration = .seconds(1)

    var line: String? {
        switch self {
        case .editing, .sending: return nil
        case .unpaired: return L.text("outcome.unpaired")
        case .unreadable: return L.text("outcome.unreadable")
        case let .finished(outcome):
            switch outcome {
            case let .delivered(answered): return L.text(answered ? "outcome.answered" : "outcome.delivered")
            case .queued: return L.text("outcome.queued")
            case let .entryOff(entry): return L.text(entry == .share ? "outcome.off.share" : "outcome.off.safari")
            case .deviceRemoved: return L.text("outcome.removed")
            case let .failed(problem): return L.text("outcome.\(problem.rawValue)")
            }
        }
    }

    var followUpTitle: String? {
        switch self {
        case .finished(.entryOff): L.text("outcome.off.button")
        case .finished(.deviceRemoved), .unpaired: L.text("outcome.open")
        default: nil
        }
    }

    func followUpURL(_ entry: HandoverEntry) -> URL? {
        switch self {
        case .finished(.entryOff): HandoverLink.url(entry)
        case .finished(.deviceRemoved), .unpaired: HandoverLink.home
        default: nil
        }
    }

    var closesItself: Bool {
        switch self {
        case .finished(.delivered), .finished(.queued): true
        default: false
        }
    }

    var isDone: Bool {
        if case .finished(.delivered) = self { return true }
        return false
    }

    var outcome: HandoverOutcome? {
        if case let .finished(outcome) = self { return outcome }
        return nil
    }
}

public struct HandoverSheet: View {
    @Bindable private var model: HandoverSheetModel
    @FocusState private var typing: Bool

    public init(model: HandoverSheetModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: DesignTokens.Handover.sheetGap) {
            header
            if model.content != nil {
                card
                if model.phase == .editing || model.phase == .sending {
                    field
                } else if let sent = model.sentRequest {
                    Text(sent)
                        .hmType(DesignTokens.TypeScale.bubble)
                        .foregroundStyle(Color.hmMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(EdgeInsets(top: DesignTokens.Handover.fieldPaddingVertical, leading: DesignTokens.Handover.fieldPaddingHorizontal, bottom: DesignTokens.Handover.fieldPaddingVertical, trailing: DesignTokens.Handover.fieldPaddingHorizontal))
                        .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Handover.fieldRadius, style: .continuous))
                }
                Text(model.note)
                    .hmType(DesignTokens.TypeScale.caption)
                    .foregroundStyle(Color.hmMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, DesignTokens.Handover.noteInset)
            }
            footer
        }
        .padding(EdgeInsets(top: DesignTokens.Size.sheetPaddingTop, leading: DesignTokens.Size.sheetPaddingHorizontal, bottom: DesignTokens.Size.sheetPaddingBottom, trailing: DesignTokens.Size.sheetPaddingHorizontal))
        .background(Color.hmBackground, in: UnevenRoundedRectangle(topLeadingRadius: DesignTokens.Radius.sheetTop, topTrailingRadius: DesignTokens.Radius.sheetTop, style: .continuous))
    }

    private var header: some View {
        ZStack {
            Text(L.text("sheet.title"))
                .hmType(DesignTokens.TypeScale.sheetTitle)
                .foregroundStyle(Color.hmText)
            HStack {
                Button(action: model.onClose) {
                    Icon(.x, size: DesignTokens.Handover.closeIcon)
                        .foregroundStyle(Color.hmText)
                        .frame(width: DesignTokens.Size.glassButton, height: DesignTokens.Size.glassButton)
                        .background(Color.hmFill, in: Circle())
                }
                .buttonStyle(.pressable)
                .accessibilityLabel(Text(L.text("sheet.close")))
                Spacer()
            }
        }
    }

    private var card: some View {
        HStack(spacing: DesignTokens.Size.rowGap - 2) {
            Icon(model.cardIcon, size: DesignTokens.IconSize.listRow)
                .foregroundStyle(Color.hmMuted)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.cardTitle)
                    .hmType(DesignTokens.TypeScale.body)
                    .foregroundStyle(Color.hmText)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let subtitle = model.cardSubtitle {
                    Text(subtitle)
                        .hmType(DesignTokens.TypeScale.caption)
                        .foregroundStyle(Color.hmMuted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .himawariCard(padding: EdgeInsets(top: DesignTokens.Handover.cardPaddingVertical, leading: DesignTokens.Handover.cardPaddingHorizontal, bottom: DesignTokens.Handover.cardPaddingVertical, trailing: DesignTokens.Handover.cardPaddingHorizontal))
    }

    private var field: some View {
        TextField(text: $model.request, prompt: Text(L.text("sheet.placeholder")).foregroundStyle(Color.hmMuted), axis: .vertical) {
            Text(L.text("sheet.placeholder"))
        }
        .hmType(DesignTokens.TypeScale.bubble)
        .foregroundStyle(Color.hmText)
        .lineLimit(3...8)
        .accessibilityIdentifier("handover.request")
        .focused($typing)
        .disabled(model.phase != .editing)
        .padding(EdgeInsets(top: DesignTokens.Handover.fieldPaddingVertical, leading: DesignTokens.Handover.fieldPaddingHorizontal, bottom: DesignTokens.Handover.fieldPaddingVertical, trailing: DesignTokens.Handover.fieldPaddingHorizontal))
        .frame(minHeight: DesignTokens.Handover.fieldMinHeight, alignment: .topLeading)
        .background(Color.hmFill, in: RoundedRectangle(cornerRadius: DesignTokens.Handover.fieldRadius, style: .continuous))
    }

    @ViewBuilder
    private var footer: some View {
        switch model.phase {
        case .editing, .sending:
            Button(action: model.submit) {
                Text(L.text(model.phase == .sending ? "sheet.sending" : "sheet.send"))
            }
            .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.Handover.buttonFontSize))
            .disabled(model.phase == .sending)
        default:
            VStack(spacing: DesignTokens.Handover.outcomeGap) {
                HStack(spacing: DesignTokens.Size.composerGap + 2) {
                    if model.isDone {
                        Icon(.check, size: DesignTokens.Handover.doneIcon).foregroundStyle(Color.hmSun)
                    }
                    Text(model.outcomeLine ?? "")
                        .hmType(DesignTokens.TypeScale.body)
                        .foregroundStyle(Color.hmText)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, minHeight: DesignTokens.Size.pillBig)
                if let title = model.followUpTitle {
                    Button(action: model.followUp) { Text(title) }
                        .buttonStyle(CapsuleButtonStyle(.primary, height: DesignTokens.Size.pillBig, fontSize: DesignTokens.Handover.buttonFontSize))
                }
            }
        }
    }
}

struct HandoverSheetScene: View {
    let model: HandoverSheetModel

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            HandoverSheet(model: model)
        }
        .ignoresSafeArea(edges: .bottom)
    }
}
