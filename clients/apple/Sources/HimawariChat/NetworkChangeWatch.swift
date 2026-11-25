import Foundation
#if canImport(Network)
import Network
#endif

@MainActor
final class NetworkChangeWatch {
    #if canImport(Network)
    private struct Route: Equatable {
        let reachable: Bool
        let interfaces: [NWInterface.InterfaceType]
    }

    private let monitor = NWPathMonitor()
    private var seen: Route?
    #endif
    private let changed: @MainActor () -> Void

    init(changed: @escaping @MainActor () -> Void) {
        self.changed = changed
        #if canImport(Network)
        monitor.pathUpdateHandler = { [weak self] path in
            let route = Route(reachable: path.status == .satisfied, interfaces: path.availableInterfaces.map(\.type))
            Task { @MainActor in self?.update(route) }
        }
        monitor.start(queue: DispatchQueue(label: "himawari.network-change"))
        #endif
    }

    #if canImport(Network)
    private func update(_ route: Route) {
        defer { seen = route }
        guard let seen, seen != route, route.reachable else { return }
        changed()
    }
    #endif

    deinit {
        #if canImport(Network)
        monitor.cancel()
        #endif
    }
}
