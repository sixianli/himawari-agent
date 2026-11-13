import Foundation
import Testing
@testable import HimawariCore

@Suite struct HapticPolicyTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func everyEventHasAFixedPattern() {
        #expect(HapticEvent.messageSent.pattern == .impactLight)
        #expect(HapticEvent.stopPressed.pattern == .impactRigid)
        #expect(HapticEvent.sheetSettled.pattern == .impactSoft)
        #expect(HapticEvent.pairingSucceeded.pattern == .bloom)
        #expect(HapticEvent.approvalNeeded.pattern == .knock)
        #expect(HapticEvent.approvalNeededWeighty.pattern == .knockFirm)
        #expect(HapticEvent.longTaskFinished.pattern == .success)
        #expect(HapticEvent.taskFailed.pattern == .warning)
    }

    @Test func nothingWhileRecordingExceptTheStartCue() {
        var policy = HapticPolicy()
        let recording = HapticSituation(recording: true)
        #expect(policy.decide(.messageSent, in: recording, at: now) == nil)
        #expect(policy.decide(.approvalNeeded, in: recording, at: now) == nil)
        #expect(policy.decide(.listeningStarted, in: recording, at: now) == .impactMedium)
    }

    @Test func whileViewingOnlyApprovalAndLongWaitsBuzz() {
        var policy = HapticPolicy()
        let viewing = HapticSituation(ownerViewingThisPage: true, waitedSeconds: 4)
        #expect(policy.decide(.longTaskFinished, in: viewing, at: now) == nil)
        #expect(policy.decide(.taskFailed, in: viewing, at: now) == nil)
        #expect(policy.decide(.approvalNeeded, in: viewing, at: now) == .knock)
        let longWait = HapticSituation(ownerViewingThisPage: true, waitedSeconds: 12)
        #expect(policy.decide(.longTaskFinished, in: longWait, at: now) == .success)
        let away = HapticSituation(ownerViewingThisPage: false, waitedSeconds: 1)
        #expect(policy.decide(.taskFailed, in: away, at: now) == .warning)
    }

    @Test func theWaitThresholdComesFromSettings() {
        var policy = HapticPolicy(settings: HapticSettings(finishedAfterSeconds: 30))
        #expect(policy.decide(.longTaskFinished, in: HapticSituation(ownerViewingThisPage: true, waitedSeconds: 12), at: now) == nil)
        #expect(policy.decide(.longTaskFinished, in: HapticSituation(ownerViewingThisPage: true, waitedSeconds: 31), at: now) == .success)
    }

    @Test func repeatsWithinTheWindowBuzzOnce() {
        var policy = HapticPolicy()
        #expect(policy.decide(.messageSent, in: HapticSituation(), at: now) == .impactLight)
        #expect(policy.decide(.messageSent, in: HapticSituation(), at: now.addingTimeInterval(1)) == nil)
        #expect(policy.decide(.stopPressed, in: HapticSituation(), at: now.addingTimeInterval(1)) == .impactRigid)
        #expect(policy.decide(.messageSent, in: HapticSituation(), at: now.addingTimeInterval(4)) == .impactLight)
    }

    @Test func watchAndQuietTimeLeaveOnlyWhatTheyShould() {
        var policy = HapticPolicy()
        #expect(policy.decide(.longTaskFinished, in: HapticSituation(watchTakesHimawariEvents: true), at: now) == nil)
        #expect(policy.decide(.messageSent, in: HapticSituation(watchTakesHimawariEvents: true), at: now) == .impactLight)
        #expect(policy.decide(.taskFailed, in: HapticSituation(quietTime: true), at: now) == nil)
        #expect(policy.decide(.approvalNeeded, in: HapticSituation(quietTime: true), at: now) == .knock)
    }

    @Test func levelsAndTheSystemSwitch() {
        var policy = HapticPolicy()
        #expect(policy.decide(.messageSent, in: HapticSituation(level: .essential), at: now) == nil)
        #expect(policy.decide(.approvalNeeded, in: HapticSituation(level: .essential), at: now) == .knock)
        #expect(policy.decide(.listeningStarted, in: HapticSituation(level: .essential), at: now) == .impactMedium)
        #expect(policy.decide(.listeningStopped, in: HapticSituation(level: .off), at: now) == nil)
        #expect(policy.decide(.approvalNeededWeighty, in: HapticSituation(systemHapticsEnabled: false), at: now) == nil)
    }
}
