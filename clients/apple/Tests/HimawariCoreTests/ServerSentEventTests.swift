import Foundation
import Testing
@testable import HimawariCore

@Suite struct ServerSentEventTests {
    @Test func dispatchesOnBlankLineAcrossChunks() {
        var parser = ServerSentEventParser()
        #expect(parser.feed(": connected\n\nid: c_1\nevent: mess").isEmpty)
        let events = parser.feed("age\ndata: {\"a\":1}\n\n")
        #expect(events == [ServerSentEvent(event: "message", data: "{\"a\":1}", id: "c_1")])
    }

    @Test func joinsMultipleDataLinesAndHandlesCRLF() {
        var parser = ServerSentEventParser()
        let events = parser.feed("event: x\r\ndata: one\r\ndata: two\r\n\r\n")
        #expect(events == [ServerSentEvent(event: "x", data: "one\ntwo", id: nil)])
    }

    @Test func crlfSplitAcrossChunksAndBareCarriageReturnsEndLines() {
        var parser = ServerSentEventParser()
        #expect(parser.feed("event: x\r").isEmpty)
        #expect(parser.feed("\ndata: one\r\r").isEmpty)
        #expect(parser.feed("\ndata: two\r\r") == [ServerSentEvent(event: "x", data: "one", id: nil)])
        #expect(parser.feed("\n") == [ServerSentEvent(event: "message", data: "two", id: nil)])
        #expect(parser.feed("data: three\r\rdata: four\n\n") == [ServerSentEvent(event: "message", data: "three", id: nil), ServerSentEvent(event: "message", data: "four", id: nil)])
    }

    @Test func commentsAloneDispatchNothing() {
        var parser = ServerSentEventParser()
        #expect(parser.feed(": ping\n\n: ping\n\n").isEmpty)
    }

    @Test func decodesThreadEventAndSnapshotRequired() throws {
        let data = """
        {"type":"thread.event","payload":{"eventId":"e1","threadId":"t1","revision":2,"cursor":"c9","causationCommandId":"x","eventType":"thread.message.committed","payloadRef":null,"occurredAt":"2026-11-12T00:00:00Z"}}
        """
        let event = DeviceEventDecoder.decode(ServerSentEvent(event: "message", data: data, id: "c9"))
        guard case let .thread(thread)? = event else {
            Issue.record("expected thread event")
            return
        }
        #expect(thread.threadId == "t1")
        #expect(thread.cursor == "c9")
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "thread.snapshot_required", data: "{}", id: nil)) == .resyncRequired)
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "gateway.stream_error", data: "{\"code\":\"IDENTITY_SESSION_INVALID\"}", id: nil)) == .sessionInvalid)
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "gateway.heartbeat", data: "{}", id: nil)) == nil)
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "device.scanned", data: "{}", id: "c10")) == nil)
    }

    @Test func decodesExecutionText() {
        let data = """
        {"type":"thread.execution_text","payload":{"threadId":"t1","runId":"r1","itemId":"i1","offset":4,"text":"大阪","observedAt":"2026-11-12T00:00:00Z"}}
        """
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "message", data: data, id: nil))
            == .executionText(ExecutionText(threadId: "t1", runId: "r1", itemId: "i1", offset: 4, text: "大阪")))
    }

    @Test func decodesExecutionStreamEventsNamedByType() {
        let changed = """
        {"type":"thread.execution_changed","payload":{"threadId":"t1","runId":"r1","runRevision":2,"traceSequence":5,"resourceRevision":"x","observedAt":"2026-11-12T00:00:00Z"}}
        """
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "thread.execution_changed", data: changed, id: nil))
            == .executionChanged(threadId: "t1", runId: "r1"))
        let text = """
        {"type":"thread.execution_text","payload":{"threadId":"t1","runId":"r1","itemId":"i1","offset":0,"text":"好","observedAt":"2026-11-12T00:00:00Z"}}
        """
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "thread.execution_text", data: text, id: nil))
            == .executionText(ExecutionText(threadId: "t1", runId: "r1", itemId: "i1", offset: 0, text: "好")))
        #expect(DeviceEventDecoder.decode(ServerSentEvent(event: "thread.execution_unavailable", data: "{\"code\":\"NOT_FOUND\"}", id: nil)) == .unavailable)
    }
}
