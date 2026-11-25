import Foundation
@testable import HimawariCore
import Testing

@Suite struct ThreadRunStateTests {
    static func run(_ status: String) throws -> ThreadRunSummary {
        try JSONDecoder().decode(ThreadRunSummary.self, from: Data(#"{"runId":"r","revision":1,"status":"\#(status)"}"#.utf8))
    }

    @Test func sheIsBusyWhileARunIsBeingWorkedOn() throws {
        for status in ["accepted", "building_context", "running", "reconciling_external_result"] {
            #expect(try Self.run(status).isWorking)
        }
    }

    @Test func sheIsNotBusyWhenARunEndedOrWaitsForTheOwner() throws {
        for status in ["awaiting_approval", "completed", "failed", "cancelled", "unknown_future_state"] {
            #expect(try !Self.run(status).isWorking)
        }
    }
}
