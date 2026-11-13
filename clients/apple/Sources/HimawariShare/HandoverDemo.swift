#if DEBUG
import Foundation
import HimawariCore
import HimawariDesign
import SwiftUI

public enum HandoverDemo {
    public enum Sheet: Sendable {
        case typing
        case answered
        case queued
        case entryOff
        case removed
        case unpaired
    }

    public enum Entry: Sendable {
        case safariGuide
        case safariOn
        case shareOn
    }

    static let page = HandoverContent.page(url: "https://tabelog.com/osaka/shin-osaka/lunch", title: "新大阪站周边午餐 10 选", text: "从车站走路 5 分钟以内")
    static let request = "周五和田中吃饭，帮我挑一家安静的"

    @MainActor
    public static func sheet(_ kind: Sheet) -> some View {
        let model: HandoverSheetModel = switch kind {
        case .typing: HandoverSheetModel(demo: .share, content: page, request: request, phase: .editing)
        case .answered: HandoverSheetModel(demo: .share, content: page, request: request, phase: .finished(.delivered(answered: true)))
        case .queued: HandoverSheetModel(demo: .share, content: page, request: request, phase: .finished(.queued))
        case .entryOff: HandoverSheetModel(demo: .share, content: page, request: "", phase: .finished(.entryOff(.share)))
        case .removed: HandoverSheetModel(demo: .share, content: page, request: "", phase: .finished(.deviceRemoved))
        case .unpaired: HandoverSheetModel(demo: .share, content: page, request: "", phase: .unpaired)
        }
        return HandoverDemoBackdrop(model: model)
    }

    @MainActor
    public static func entry(_ kind: Entry) -> some View {
        let store = MemoryLocalStore()
        let settings = HandoverSettings(shareOn: true, safariOn: true, safariUsedAt: kind == .safariGuide ? nil : Date(timeIntervalSince1970: 1_800_000_000))
        try? settings.save(to: store)
        let model = HandoverEntryModel(store: store)
        return NavigationStack {
            switch kind {
            case .safariGuide, .safariOn: SafariEntryView(model: model)
            case .shareOn: ShareEntryView(model: model)
            }
        }
    }
}

struct HandoverDemoBackdrop: View {
    let model: HandoverSheetModel

    var body: some View {
        HandoverSheetScene(model: model)
            .background(Color.hmScrim.ignoresSafeArea())
    }
}
#endif
