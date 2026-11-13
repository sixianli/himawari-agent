import Foundation

public struct AudioPortSnapshot: Sendable, Equatable {
    public let bluetooth: Bool
    public let uid: String
    public let name: String

    public init(bluetooth: Bool, uid: String, name: String) {
        self.bluetooth = bluetooth
        self.uid = uid
        self.name = name
    }
}

public enum HeadphoneWear {
    public static func playsThroughSameHeadset(input: AudioPortSnapshot?, outputs: [AudioPortSnapshot]) -> Bool {
        guard let input, input.bluetooth else { return false }
        return outputs.contains { output in
            output.bluetooth && (output.uid == input.uid || (!output.name.isEmpty && output.name == input.name))
        }
    }

    public static func worn(motionFresh: Bool?, playsThroughSameHeadset: Bool) -> Bool? {
        motionFresh.map { $0 && playsThroughSameHeadset }
    }
}
