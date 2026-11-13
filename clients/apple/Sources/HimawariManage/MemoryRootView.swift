import HimawariCore
import HimawariDesign
import SwiftUI

public struct MemoryRootView: View {
    private let api: DeviceAPI

    public init(api: DeviceAPI) {
        self.api = api
    }

    public var body: some View {
        EmptyStateView(Text(PlaceholderText.notConnected))
            .himawariScreenBackground()
    }
}
