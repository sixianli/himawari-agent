import HimawariCore
import HimawariWatchUI
import SwiftUI
import WidgetKit

struct GlanceEntry: TimelineEntry {
    let date: Date
    let state: WatchComplicationState
}

struct GlanceProvider: TimelineProvider {
    private var store: WatchComplicationStore {
        WatchComplicationStore(appGroup: Bundle.main.object(forInfoDictionaryKey: "HimawariAppGroup") as? String ?? "")
    }

    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(date: Date(), state: WatchComplicationState(awaiting: 3, latest: nil, updatedAt: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        completion(GlanceEntry(date: Date(), state: context.isPreview ? placeholder(in: context).state : store.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        completion(Timeline(entries: [GlanceEntry(date: Date(), state: store.load())], policy: .never))
    }
}

struct GlanceView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        WatchGlanceView(state: entry.state, family: family)
    }
}

struct GlanceWidget: Widget {
    let kind = "himawari.watch.glance"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: GlanceProvider()) { entry in
            GlanceView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Himawari")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner])
    }
}

@main
struct HimawariWatchWidgets: WidgetBundle {
    var body: some Widget {
        GlanceWidget()
    }
}
