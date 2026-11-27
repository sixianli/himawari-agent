import CoreGraphics

public enum DesignTokens {
    public enum Colors {
        public static let bg = PaletteToken(light: RGBA(red: 252 / 255, green: 252 / 255, blue: 251 / 255, alpha: 1), dark: RGBA(red: 30 / 255, green: 30 / 255, blue: 30 / 255, alpha: 1))
        public static let bubble = PaletteToken(light: RGBA(red: 239 / 255, green: 239 / 255, blue: 236 / 255, alpha: 1), dark: RGBA(red: 44 / 255, green: 44 / 255, blue: 43 / 255, alpha: 1))
        public static let bubbleCode = PaletteToken(light: RGBA(red: 37 / 255, green: 41 / 255, blue: 33 / 255, alpha: 0.11), dark: RGBA(red: 255 / 255, green: 255 / 255, blue: 255 / 255, alpha: 0.06))
        public static let bubbleOwner = PaletteToken(light: RGBA(red: 154 / 255, green: 98 / 255, blue: 0 / 255, alpha: 1), dark: RGBA(red: 154 / 255, green: 98 / 255, blue: 0 / 255, alpha: 1))
        public static let danger = PaletteToken(light: RGBA(red: 167 / 255, green: 60 / 255, blue: 48 / 255, alpha: 1), dark: RGBA(red: 239 / 255, green: 160 / 255, blue: 149 / 255, alpha: 1))
        public static let fill = PaletteToken(light: RGBA(red: 37 / 255, green: 41 / 255, blue: 33 / 255, alpha: 0.06), dark: RGBA(red: 228 / 255, green: 228 / 255, blue: 225 / 255, alpha: 0.08))
        public static let fill2 = PaletteToken(light: RGBA(red: 37 / 255, green: 41 / 255, blue: 33 / 255, alpha: 0.11), dark: RGBA(red: 228 / 255, green: 228 / 255, blue: 225 / 255, alpha: 0.15))
        public static let glass = PaletteToken(light: RGBA(red: 255 / 255, green: 255 / 255, blue: 255 / 255, alpha: 0.74), dark: RGBA(red: 56 / 255, green: 56 / 255, blue: 56 / 255, alpha: 0.74))
        public static let glassLine = PaletteToken(light: RGBA(red: 255 / 255, green: 255 / 255, blue: 255 / 255, alpha: 0.8), dark: RGBA(red: 255 / 255, green: 255 / 255, blue: 255 / 255, alpha: 0.1))
        public static let glow = PaletteToken(light: RGBA(red: 232 / 255, green: 176 / 255, blue: 74 / 255, alpha: 0.34), dark: RGBA(red: 239 / 255, green: 178 / 255, blue: 60 / 255, alpha: 0.18))
        public static let glyph = PaletteToken(light: RGBA(red: 138 / 255, green: 90 / 255, blue: 0 / 255, alpha: 1), dark: RGBA(red: 242 / 255, green: 187 / 255, blue: 79 / 255, alpha: 1))
        public static let highlight = PaletteToken(light: RGBA(red: 248 / 255, green: 235 / 255, blue: 203 / 255, alpha: 1), dark: RGBA(red: 75 / 255, green: 63 / 255, blue: 37 / 255, alpha: 1))
        public static let muted = PaletteToken(light: RGBA(red: 86 / 255, green: 91 / 255, blue: 80 / 255, alpha: 1), dark: RGBA(red: 180 / 255, green: 180 / 255, blue: 174 / 255, alpha: 1))
        public static let onBubbleOwner = PaletteToken(light: RGBA(red: 252 / 255, green: 252 / 255, blue: 251 / 255, alpha: 1), dark: RGBA(red: 252 / 255, green: 252 / 255, blue: 251 / 255, alpha: 1))
        public static let onText = PaletteToken(light: RGBA(red: 252 / 255, green: 252 / 255, blue: 251 / 255, alpha: 1), dark: RGBA(red: 30 / 255, green: 30 / 255, blue: 30 / 255, alpha: 1))
        public static let scrim = PaletteToken(light: RGBA(red: 0 / 255, green: 0 / 255, blue: 0 / 255, alpha: 0.28), dark: RGBA(red: 0 / 255, green: 0 / 255, blue: 0 / 255, alpha: 0.5))
        public static let separator = PaletteToken(light: RGBA(red: 37 / 255, green: 41 / 255, blue: 33 / 255, alpha: 0.09), dark: RGBA(red: 228 / 255, green: 228 / 255, blue: 225 / 255, alpha: 0.1))
        public static let speak = PaletteToken(light: RGBA(red: 37 / 255, green: 41 / 255, blue: 33 / 255, alpha: 1), dark: RGBA(red: 12 / 255, green: 12 / 255, blue: 12 / 255, alpha: 1))
        public static let success = PaletteToken(light: RGBA(red: 66 / 255, green: 104 / 255, blue: 42 / 255, alpha: 1), dark: RGBA(red: 172 / 255, green: 205 / 255, blue: 136 / 255, alpha: 1))
        public static let successRing = PaletteToken(light: RGBA(red: 66 / 255, green: 104 / 255, blue: 42 / 255, alpha: 0.16), dark: RGBA(red: 172 / 255, green: 205 / 255, blue: 136 / 255, alpha: 0.2))
        public static let sun = PaletteToken(light: RGBA(red: 154 / 255, green: 98 / 255, blue: 0 / 255, alpha: 1), dark: RGBA(red: 242 / 255, green: 187 / 255, blue: 79 / 255, alpha: 1))
        public static let sunBright = PaletteToken(light: RGBA(red: 201 / 255, green: 135 / 255, blue: 10 / 255, alpha: 1), dark: RGBA(red: 239 / 255, green: 178 / 255, blue: 60 / 255, alpha: 1))
        public static let surface = PaletteToken(light: RGBA(red: 255 / 255, green: 255 / 255, blue: 255 / 255, alpha: 1), dark: RGBA(red: 42 / 255, green: 42 / 255, blue: 42 / 255, alpha: 1))
        public static let switchOff = PaletteToken(light: RGBA(red: 201 / 255, green: 203 / 255, blue: 194 / 255, alpha: 1), dark: RGBA(red: 85 / 255, green: 85 / 255, blue: 79 / 255, alpha: 1))
        public static let text = PaletteToken(light: RGBA(red: 37 / 255, green: 41 / 255, blue: 33 / 255, alpha: 1), dark: RGBA(red: 228 / 255, green: 228 / 255, blue: 225 / 255, alpha: 1))
        public static let badge = danger
        public static let codeComment = muted
        public static let codeKeyword = sun
        public static let codeNumber = danger
        public static let codeString = success
        public static let codeType = glyph
        public static let iconTile = highlight
        public static let link = sun
        public static let replyBar = sun
        public static let streamingDot = sunBright
    }

    public enum Shadows {
        public static let lift = ShadowToken(x: 0, y: 2, blur: 10, color: PaletteToken(light: RGBA(red: 0 / 255, green: 0 / 255, blue: 0 / 255, alpha: 0.07), dark: RGBA(red: 0 / 255, green: 0 / 255, blue: 0 / 255, alpha: 0.35)))
        public static let liftBig = ShadowToken(x: 0, y: 8, blur: 28, color: PaletteToken(light: RGBA(red: 0 / 255, green: 0 / 255, blue: 0 / 255, alpha: 0.13), dark: RGBA(red: 0 / 255, green: 0 / 255, blue: 0 / 255, alpha: 0.5)))
        public static let puck = ShadowToken(x: 0, y: 4, blur: 14, color: PaletteToken(light: RGBA(red: 0 / 255, green: 0 / 255, blue: 0 / 255, alpha: 0.25), dark: RGBA(red: 0 / 255, green: 0 / 255, blue: 0 / 255, alpha: 0.25)))
    }

    public enum Glass {
        public static let blur: CGFloat = 22
        public static let saturate: CGFloat = 1.8
    }

    public enum Radius {
        public static let bubble: CGFloat = 26
        public static let card: CGFloat = 28
        public static let composer: CGFloat = 31
        public static let glassButton: CGFloat = 24
        public static let offlineBanner: CGFloat = 20
        public static let pill: CGFloat = 23
        public static let pillBig: CGFloat = 28
        public static let segment: CGFloat = 22
        public static let sheetTop: CGFloat = 38
    }

    public enum Size {
        public static let badge: CGFloat = 18
        public static let bubbleMaxWidth: CGFloat = 290
        public static let cardPaddingX: CGFloat = 20
        public static let chatPaddingX: CGFloat = 20
        public static let composerBottom: CGFloat = 30
        public static let composerButton: CGFloat = 46
        public static let composerGap: CGFloat = 6
        public static let composerHeight: CGFloat = 62
        public static let composerInsetX: CGFloat = 12
        public static let composerPadding: CGFloat = 8
        public static let composerWidth: CGFloat = 366
        public static let emptyMark: CGFloat = 92
        public static let emptyMinHeight: CGFloat = 300
        public static let fadeComposer: CGFloat = 130
        public static let fadeTop: CGFloat = 134
        public static let fadeTopSolid: CGFloat = 102
        public static let glassButton: CGFloat = 48
        public static let markDiscRatio: CGFloat = 0.92
        public static let minTapTarget: CGFloat = 44
        public static let navBarHeight: CGFloat = 64
        public static let navTop: CGFloat = 54
        public static let offlineBannerPaddingVertical: CGFloat = 9
        public static let offlineBannerPaddingHorizontal: CGFloat = 16
        public static let offlineDot: CGFloat = 8
        public static let pagePaddingX: CGFloat = 16
        public static let pairingMark: CGFloat = 148
        public static let pill: CGFloat = 46
        public static let pillBig: CGFloat = 56
        public static let pillSmall: CGFloat = 36
        public static let rowGap: CGFloat = 14
        public static let rowMinHeight: CGFloat = 60
        public static let sheetPaddingTop: CGFloat = 16
        public static let sheetPaddingHorizontal: CGFloat = 16
        public static let sheetPaddingBottom: CGFloat = 40
        public static let speakButton: CGFloat = 64
        public static let streamingDot: CGFloat = 9
        public static let switchWidth: CGFloat = 52
        public static let switchHeight: CGFloat = 32
        public static let switchKnob: CGFloat = 28
        public static let usageBar: CGFloat = 6
    }

    public enum IconSize {
        public static let chevron: CGFloat = 14
        public static let glassButton: CGFloat = 22
        public static let listRow: CGFloat = 26
        public static let processRow: CGFloat = 24
        public static let speakSize: CGFloat = 22
        public static let stroke: CGFloat = 1.6
        public static let strokeChevron: CGFloat = 2.2
        public static let strokeLarge: CGFloat = 1.3
        public static let strokeSpeak: CGFloat = 2.2
        public static let todayRow: CGFloat = 22
    }

    public enum ProcessRow {
        public static let fontSize: CGFloat = 17
        public static let gap: CGFloat = 10
        public static let shimmerSeconds: CGFloat = 2.4
    }

    public enum Opacity {
        public static let emptyMark: Double = 0.55
        public static let watchHalo: Double = 0.3
        public static let watchPressed: Double = 0.7
    }

    public enum Home {
    }

    public enum Pairing {
        public static let bannerRadius: CGFloat = 22
        public static let errorIcon: CGFloat = 72
        public static let errorTop: CGFloat = 156
        public static let glowCenterY: CGFloat = 210
        public static let glowRadius: CGFloat = 310
        public static let homeGap: CGFloat = 36
        public static let homeTop: CGFloat = 66
        public static let paddingBottom: CGFloat = 44
        public static let paddingX: CGFloat = 24
        public static let removedBannerTop: CGFloat = 6
        public static let removedTitleSize: CGFloat = 31
        public static let stepCardRadius: CGFloat = 22
        public static let stepNumberWidth: CGFloat = 20
        public static let stepRowHeight: CGFloat = 56
        public static let waitingMark: CGFloat = 120
        public static let waitingTop: CGFloat = 86
    }

    public enum Scanner {
        public static let closeButtonFillOpacity: CGFloat = 0.18
        public static let radius: CGFloat = 36
        public static let scrimOpacity: CGFloat = 0.45
        public static let stroke: CGFloat = 3
        public static let strokeOpacity: CGFloat = 0.9
        public static let window: CGFloat = 250
    }

    public enum Senses {
        public static let actionGap: CGFloat = 6
        public static let factGap: CGFloat = 18
        public static let factLabelGap: CGFloat = 2
        public static let factPadding: CGFloat = 20
        public static let footnotePaddingX: CGFloat = 8
        public static let introGap: CGFloat = 28
        public static let introIcon: CGFloat = 72
        public static let introTitleGap: CGFloat = 18
        public static let introTop: CGFloat = 34
        public static let listGap: CGFloat = 20
        public static let timeColumn: CGFloat = 48
    }

    public enum Handover {
        public static let buttonFontSize: CGFloat = 17
        public static let cardPaddingVertical: CGFloat = 14
        public static let cardPaddingHorizontal: CGFloat = 16
        public static let closeIcon: CGFloat = 18
        public static let doneIcon: CGFloat = 22
        public static let fieldMinHeight: CGFloat = 96
        public static let fieldPaddingVertical: CGFloat = 14
        public static let fieldPaddingHorizontal: CGFloat = 16
        public static let fieldRadius: CGFloat = 22
        public static let heroGap: CGFloat = 18
        public static let heroIcon: CGFloat = 72
        public static let heroTop: CGFloat = 30
        public static let noteInset: CGFloat = 8
        public static let outcomeGap: CGFloat = 14
        public static let pageGap: CGFloat = 24
        public static let popupFieldMinHeight: CGFloat = 84
        public static let sheetGap: CGFloat = 18
        public static let stepsGap: CGFloat = 18
        public static let stepsPadding: CGFloat = 20
    }

    public enum Mac {
        public static let buttonGap: CGFloat = 8
        public static let buttonHeight: CGFloat = 34
        public static let buttonPaddingX: CGFloat = 16
        public static let cardButtonGap: CGFloat = 6
        public static let cardButtonHeight: CGFloat = 32
        public static let chatColumnMaxWidth: CGFloat = 760
        public static let checklistGap: CGFloat = 14
        public static let checklistIcon: CGFloat = 20
        public static let checklistPadding: CGFloat = 24
        public static let checklistRadius: CGFloat = 28
        public static let checklistRowPadding: CGFloat = 9
        public static let checklistWidth: CGFloat = 460
        public static let chipClose: CGFloat = 14
        public static let chipHeight: CGFloat = 28
        public static let chipIcon: CGFloat = 15
        public static let chipPaddingLeading: CGFloat = 11
        public static let chipPaddingTrailing: CGFloat = 6
        public static let chipRadius: CGFloat = 14
        public static let inputAnswerMaxHeight: CGFloat = 320
        public static let inputBarPaddingX: CGFloat = 8
        public static let inputBarPaddingY: CGFloat = 6
        public static let inputBarRadius: CGFloat = 26
        public static let inputBarWidth: CGFloat = 500
        public static let inputChipGap: CGFloat = 8
        public static let inputChipsBottom: CGFloat = 2
        public static let inputChipsTop: CGFloat = 10
        public static let inputGap: CGFloat = 12
        public static let inputInnerPaddingX: CGFloat = 10
        public static let inputMark: CGFloat = 28
        public static let inputRowHeight: CGFloat = 52
        public static let noticeButtonHeight: CGFloat = 30
        public static let noticeListFade: CGFloat = 24
        public static let noticeListMaxHeight: CGFloat = 260
        public static let noticeMark: CGFloat = 30
        public static let noticePadding: CGFloat = 14
        public static let noticeRadius: CGFloat = 22
        public static let noticeWidth: CGFloat = 340
        public static let pairingMark: CGFloat = 56
        public static let pairingPadding: CGFloat = 24
        public static let pairingWidth: CGFloat = 420
        public static let panelCardPadding: CGFloat = 14
        public static let panelCardRadius: CGFloat = 18
        public static let panelGap: CGFloat = 10
        public static let panelPadding: CGFloat = 12
        public static let panelRadius: CGFloat = 26
        public static let panelWidth: CGFloat = 350
        public static let progressHeight: CGFloat = 6
        public static let settingsHeight: CGFloat = 440
        public static let settingsIcon: CGFloat = 18
        public static let settingsPaddingX: CGFloat = 18
        public static let settingsRowPadding: CGFloat = 8
        public static let settingsWidth: CGFloat = 500
        public static let settingsWindowWidth: CGFloat = 520
        public static let sidebarMaxWidth: CGFloat = 280
        public static let sidebarMinWidth: CGFloat = 200
        public static let sidebarWidth: CGFloat = 220
        public static let smallButtonHeight: CGFloat = 28
        public static let statusBadgeGap: CGFloat = 5
        public static let statusIcon: CGFloat = 17
        public static let talkRowHeight: CGFloat = 38
        public static let windowMinHeight: CGFloat = 520
        public static let windowMinWidth: CGFloat = 760
    }

    public enum Watch {
        public static let answerLineHeight: CGFloat = 20
        public static let answerSize: CGFloat = 16
        public static let buttonGap: CGFloat = 6
        public static let buttonHeight: CGFloat = 44
        public static let cardButtonTop: CGFloat = 6
        public static let cardGap: CGFloat = 6
        public static let glanceCircle: CGFloat = 76
        public static let glanceGap: CGFloat = 8
        public static let glanceHeight: CGFloat = 68
        public static let glanceMarkInset: CGFloat = 4
        public static let glancePadding: CGFloat = 6
        public static let glanceRadius: CGFloat = 20
        public static let glanceWidth: CGFloat = 160
        public static let markHalo: CGFloat = 96
        public static let markMedium: CGFloat = 56
        public static let markPairing: CGFloat = 64
        public static let markQuiet: CGFloat = 80
        public static let markSmall: CGFloat = 28
        public static let markWidget: CGFloat = 30
        public static let saidLines: CGFloat = 3
        public static let screenPadding: CGFloat = 12
        public static let talkInsetHeight: CGFloat = 24
        public static let talkInsetWidth: CGFloat = 16
        public static let talkPadding: CGFloat = 8
    }

    public enum Chat {
        public static let answerBlockGap: CGFloat = 10
        public static let attachCloseButton: CGFloat = 48
        public static let attachRecentCheck: CGFloat = 24
        public static let attachRecentCount: CGFloat = 30
        public static let attachRecentHeight: CGFloat = 120
        public static let attachRecentMaxWidth: CGFloat = 160
        public static let attachRecentRadius: CGFloat = 12
        public static let attachRowIcon: CGFloat = 19
        public static let attachRowIconStroke: CGFloat = 1.7
        public static let attachRowTile: CGFloat = 34
        public static let attachRowTileRadius: CGFloat = 10
        public static let attachSheetGap: CGFloat = 16
        public static let attachTileColumns: CGFloat = 3
        public static let attachTileFontSize: CGFloat = 15
        public static let attachTileGap: CGFloat = 10
        public static let attachTileHeight: CGFloat = 92
        public static let attachTileIcon: CGFloat = 26
        public static let attachTileIconGap: CGFloat = 8
        public static let attachTitleSize: CGFloat = 18
        public static let backgroundAlertDot: CGFloat = 6
        public static let backgroundCardGap: CGFloat = 16
        public static let backgroundCardHeaderPaddingY: CGFloat = 14
        public static let backgroundCardPaddingY: CGFloat = 6
        public static let backgroundPageGap: CGFloat = 20
        public static let backgroundRowLineGap: CGFloat = 3
        public static let backgroundRowPaddingY: CGFloat = 12
        public static let backgroundSectionGap: CGFloat = 8
        public static let backgroundStepPaddingY: CGFloat = 10
        public static let backgroundTagPaddingX: CGFloat = 8
        public static let backgroundTagPaddingY: CGFloat = 3
        public static let bubbleEdge: CGFloat = 16
        public static let bubbleGroupGap: CGFloat = 2
        public static let bubbleHerRoom: CGFloat = 40
        public static let bubbleOwnerShare: CGFloat = 0.78
        public static let bubblePaddingX: CGFloat = 14
        public static let bubblePaddingY: CGFloat = 9
        public static let bubbleRadius: CGFloat = 20
        public static let bubbleSpeakerGap: CGFloat = 14
        public static let bubbleStepGap: CGFloat = 6
        public static let bubbleTimePaddingY: CGFloat = 6
        public static let codeHeaderPaddingTop: CGFloat = 8
        public static let codePadding: CGFloat = 12
        public static let codeRadius: CGFloat = 12
        public static let copiedToastLift: CGFloat = 10
        public static let copiedToastPaddingHorizontal: CGFloat = 14
        public static let copiedToastPaddingVertical: CGFloat = 7
        public static let copiedToastSeconds: CGFloat = 1.2
        public static let emptyFadeSeconds: CGFloat = 0.4
        public static let emptyMark: CGFloat = 120
        public static let emptyWordmarkGap: CGFloat = 14
        public static let emptyWordmarkSize: CGFloat = 22
        public static let headerFade: CGFloat = 140
        public static let headerFadeSolid: CGFloat = 110
        public static let headerFadeWithBackground: CGFloat = 186
        public static let headerFadeWithBackgroundSolid: CGFloat = 156
        public static let hearingBubbleOpacity: CGFloat = 0.55
        public static let inlineCodePadding: CGFloat = 3
        public static let inlineCodeRadius: CGFloat = 4
        public static let listGap: CGFloat = 4
        public static let listIndent: CGFloat = 4
        public static let listMarkerGap: CGFloat = 6
        public static let liveActivityButton: CGFloat = 44
        public static let liveActivityIslandMark: CGFloat = 18
        public static let liveActivityIslandTrailing: CGFloat = 52
        public static let liveActivityMark: CGFloat = 40
        public static let puckBannerGap: CGFloat = 8
        public static let puckBusyLow: CGFloat = 0.7
        public static let puckContentGap: CGFloat = 12
        public static let puckLine: CGFloat = 0.5
        public static let puckMark: CGFloat = 46
        public static let puckSeeds: CGFloat = 89
        public static let puckSize: CGFloat = 56
        public static let puckTop: CGFloat = 6
        public static let quoteBar: CGFloat = 3
        public static let quoteGap: CGFloat = 10
        public static let replyBarWidth: CGFloat = 3
        public static let replyFlashOpacity: CGFloat = 0.18
        public static let replyFlashSeconds: CGFloat = 0.6
        public static let replyQuoteGap: CGFloat = 8
        public static let tableCellPaddingVertical: CGFloat = 10
        public static let tableCellPaddingHorizontal: CGFloat = 14
        public static let tableFontSize: CGFloat = 15
        public static let talkBarAreaHeight: CGFloat = 24
        public static let talkBarGap: CGFloat = 3
        public static let talkBarMaxHeight: CGFloat = 22
        public static let talkBarMinHeight: CGFloat = 5
        public static let talkBarRadius: CGFloat = 2
        public static let talkBarWidth: CGFloat = 3
        public static let talkBarsInInput: CGFloat = 9
        public static let talkBarsOnTalkPage: CGFloat = 13
        public static let talkLabelGap: CGFloat = 10
        public static let whyCardRadius: CGFloat = 12
    }

    public enum Her {
        public static let heroAvatar: CGFloat = 76
        public static let heroAvatarRadius: CGFloat = 38
        public static let heroGap: CGFloat = 6
        public static let heroMark: CGFloat = 58
        public static let heroPaddingTop: CGFloat = 18
        public static let heroPaddingHorizontal: CGFloat = 0
        public static let heroPaddingBottom: CGFloat = 4
        public static let heroWordmarkSize: CGFloat = 30
        public static let pageGap: CGFloat = 18
        public static let pagePaddingTop: CGFloat = 58
        public static let pagePaddingHorizontal: CGFloat = 16
        public static let pagePaddingBottom: CGFloat = 40
        public static let pillPaddingX: CGFloat = 24
        public static let rowSubtitleGap: CGFloat = 2
        public static let rowSymbolWidth: CGFloat = 28
        public static let rowTileRadius: CGFloat = 10
    }

    public enum Avatar {
        public static let backgroundPillFontSize: CGFloat = 14
        public static let backgroundPillGap: CGFloat = 8
        public static let backgroundPillHeight: CGFloat = 36
        public static let backgroundPillMarginTop: CGFloat = 12
        public static let backgroundPillPaddingLeft: CGFloat = 14
        public static let backgroundPillPaddingRight: CGFloat = 8
        public static let backgroundPillRadius: CGFloat = 18
        public static let busyGlowInset: CGFloat = -14
        public static let busyGlowOpacityMin: CGFloat = 0.45
        public static let busyGlowOpacityMax: CGFloat = 0.95
        public static let busyGlowScaleMin: CGFloat = 0.92
        public static let busyGlowScaleMax: CGFloat = 1.14
        public static let busyGlowSeconds: CGFloat = 2.4
        public static let mark: CGFloat = 38
        public static let radius: CGFloat = 24
        public static let size: CGFloat = 48
        public static let top: CGFloat = 52
        public static let wordmarkGap: CGFloat = 3
        public static let wordmarkLineHeight: CGFloat = 1.1
        public static let wordmarkSize: CGFloat = 18
    }

    public enum Options {
        public static let afterMessage: CGFloat = 14
        public static let chosenCaptionGap: CGFloat = 4
        public static let chosenCaptionInset: CGFloat = 8
        public static let gap: CGFloat = 8
        public static let height: CGFloat = 44
        public static let icon: CGFloat = 16
        public static let iconGap: CGFloat = 8
        public static let maxWidth: CGFloat = 330
        public static let paddingVertical: CGFloat = 10
        public static let paddingHorizontal: CGFloat = 16
        public static let radius: CGFloat = 22
        public static let staleOpacity: CGFloat = 0.42
    }

    public enum Allowance {
        public static let actionsGap: CGFloat = 14
        public static let footInset: CGFloat = 6
        public static let lockedOpacity: CGFloat = 0.5
        public static let noteGap: CGFloat = 8
        public static let pageGap: CGFloat = 20
        public static let segmentGap: CGFloat = 3
        public static let segmentHeight: CGFloat = 38
        public static let segmentInset: CGFloat = 3
    }

    public enum TypeScale {
        public static let answer = TypeToken(size: 17, weight: 400, lineHeight: 17 * 1.45, face: .system, tracking: 0)
        public static let badge = TypeToken(size: 12, weight: 700, lineHeight: nil, face: .system, tracking: 0)
        public static let body = TypeToken(size: 17, weight: 400, lineHeight: 17 * 1.35, face: .system, tracking: 0)
        public static let bubble = TypeToken(size: 17, weight: 400, lineHeight: 17 * 1.45, face: .system, tracking: 0)
        public static let caption = TypeToken(size: 13, weight: 400, lineHeight: 13 * 1.4, face: .system, tracking: 0)
        public static let emptyTitle = TypeToken(size: 24, weight: 600, lineHeight: nil, face: .system, tracking: 0)
        public static let groupLabel = TypeToken(size: 15, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let macAnswer = TypeToken(size: 15, weight: 500, lineHeight: 15 * 1.6, face: .system, tracking: 0)
        public static let macButton = TypeToken(size: 14, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let macButtonSmall = TypeToken(size: 13, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let macButtonSmallStrong = TypeToken(size: 13, weight: 600, lineHeight: nil, face: .system, tracking: 0)
        public static let macButtonStrong = TypeToken(size: 14, weight: 600, lineHeight: nil, face: .system, tracking: 0)
        public static let macChecklistTitle = TypeToken(size: 21, weight: 600, lineHeight: 21 * 1.45, face: .system, tracking: 0)
        public static let macChip = TypeToken(size: 13, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let macDraft = TypeToken(size: 17, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let macInput = TypeToken(size: 19, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let macLabel = TypeToken(size: 12, weight: 600, lineHeight: nil, face: .system, tracking: 0)
        public static let macNotice = TypeToken(size: 15.5, weight: 600, lineHeight: 15.5 * 1.45, face: .system, tracking: 0)
        public static let macRow = TypeToken(size: 15, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let macRowStrong = TypeToken(size: 15, weight: 600, lineHeight: nil, face: .system, tracking: 0)
        public static let macSentence = TypeToken(size: 16, weight: 600, lineHeight: 16 * 1.45, face: .system, tracking: 0)
        public static let macSetting = TypeToken(size: 13.5, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let macSmall = TypeToken(size: 12.5, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let navTitle = TypeToken(size: 17, weight: 600, lineHeight: nil, face: .system, tracking: 0)
        public static let offlineBanner = TypeToken(size: 14, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let option = TypeToken(size: 16, weight: 400, lineHeight: 16 * 1.35, face: .system, tracking: 0)
        public static let pairingNumber = TypeToken(size: 54, weight: 700, lineHeight: nil, face: .rounded, tracking: 2)
        public static let rowAction = TypeToken(size: 15, weight: 600, lineHeight: nil, face: .system, tracking: 0)
        public static let secondary = TypeToken(size: 15, weight: 400, lineHeight: 15 * 1.45, face: .system, tracking: 0)
        public static let senseTime = TypeToken(size: 15, weight: 600, lineHeight: nil, face: .rounded, tracking: 0)
        public static let senseTitle = TypeToken(size: 26, weight: 600, lineHeight: 26 * 1.4, face: .system, tracking: 0)
        public static let sheetTitle = TypeToken(size: 18, weight: 700, lineHeight: nil, face: .system, tracking: 0)
        public static let title1 = TypeToken(size: 34, weight: 700, lineHeight: 44, face: .system, tracking: 0)
        public static let watchAnswer = TypeToken(size: 16, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let watchAnswerStrong = TypeToken(size: 16, weight: 600, lineHeight: nil, face: .rounded, tracking: 0)
        public static let watchButton = TypeToken(size: 16, weight: 500, lineHeight: nil, face: .rounded, tracking: 0)
        public static let watchCaption = TypeToken(size: 12, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let watchFootnote = TypeToken(size: 13, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let watchNumber = TypeToken(size: 34, weight: 700, lineHeight: nil, face: .rounded, tracking: 0)
        public static let watchSentence = TypeToken(size: 17, weight: 600, lineHeight: nil, face: .rounded, tracking: 0)
        public static let watchTime = TypeToken(size: 13, weight: 600, lineHeight: nil, face: .rounded, tracking: 0)
    }
}
