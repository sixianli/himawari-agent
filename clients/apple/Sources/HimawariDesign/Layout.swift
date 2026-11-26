import CoreGraphics

public enum ManageLayout {
    public enum DetailSheet {
        public static let title = TypeToken(size: 26, weight: 600, lineHeight: 26 * 1.4, face: .system, tracking: 0)
        public static let fieldLabel = TypeToken(size: 13, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let fieldValue = TypeToken(size: 17, weight: 400, lineHeight: 17 * 1.45, face: .system, tracking: 0)
        public static let action = TypeToken(size: 17, weight: 400, lineHeight: nil, face: .system, tracking: 0)
        public static let paddingTop: CGFloat = 8
        public static let paddingHorizontal: CGFloat = 20
        public static let paddingBottom: CGFloat = 40
        public static let gap: CGFloat = 22
        public static let titleGap: CGFloat = 12
        public static let titleTopInset: CGFloat = 4
        public static let grabberWidth: CGFloat = 36
        public static let grabberHeight: CGFloat = 5
        public static let grabberRadius: CGFloat = 3
        public static let closeSize: CGFloat = 48
        public static let closeIcon: CGFloat = 18
        public static let fieldPaddingHorizontal: CGFloat = 20
        public static let fieldPaddingVertical: CGFloat = 13
        public static let fieldGap: CGFloat = 3
        public static let actionHeight: CGFloat = 48
        public static let destructivePadding: CGFloat = 6
        public static let actionPadding: CGFloat = 28
    }

    public enum EditSheet {
        public static let text = TypeToken(size: 22, weight: 600, lineHeight: 22 * 1.55, face: .system, tracking: 0)
        public static let save = TypeToken(size: 17, weight: 600, lineHeight: nil, face: .system, tracking: 0)
        public static let gap: CGFloat = 16
        public static let headerButton: CGFloat = 48
        public static let closeIcon: CGFloat = 18
        public static let cardPaddingVertical: CGFloat = 18
        public static let cardPaddingHorizontal: CGFloat = 20
        public static let cardMinHeight: CGFloat = 150
        public static let notePadding: CGFloat = 6
    }

    public enum DetailSheetShape {
        public static let cornerRadius: CGFloat = 36
    }

    public enum SettingsSheet {
        public static let pageGap: CGFloat = 20
        public static let cardListGap: CGFloat = 14
        public static let headerButton: CGFloat = 48
        public static let groupGap: CGFloat = 10
        public static let groupLabelPadding: CGFloat = 4
        public static let rowsPaddingHorizontal: CGFloat = 20
        public static let rowMinHeight: CGFloat = 60
        public static let rowPaddingVertical: CGFloat = 11
        public static let rowGap: CGFloat = 14
        public static let rowTextGap: CGFloat = 2
        public static let rowValue = TypeToken(size: 17, weight: 400, lineHeight: 17 * 1.35, face: .system, tracking: 0)
    }

    public enum VaultSheet {
        public static let gap: CGFloat = 20
        public static let formGap: CGFloat = 16
        public static let buttonHeight: CGFloat = 52
        public static let buttonGap: CGFloat = 10
        public static let tagPaddingHorizontal: CGFloat = 8
        public static let tagPaddingVertical: CGFloat = 2
        public static let tile: CGFloat = 44
        public static let tileRadius: CGFloat = 12
        public static let tileIcon: CGFloat = 22
        public static let warningIcon: CGFloat = 56
        public static let warningTop: CGFloat = 24
        public static let fieldMinHeight: CGFloat = 52
        public static let itemTitle = TypeToken(size: 20, weight: 700, lineHeight: nil, face: .system, tracking: 0)
        public static let warningTitle = TypeToken(size: 24, weight: 700, lineHeight: 24 * 1.35, face: .system, tracking: 0)
        public static let note = TypeToken(size: 13, weight: 400, lineHeight: 13 * 1.5, face: .system, tracking: 0)
    }

    public enum DeviceSheet {
        public static let rowGap: CGFloat = 16
        public static let rowTextGap: CGFloat = 10
        public static let addLinkPadding: CGFloat = 20
        public static let linkMinHeight: CGFloat = 44
        public static let detailGap: CGFloat = 22
        public static let buttonGap: CGFloat = 8
        public static let askTitle = TypeToken(size: 24, weight: 600, lineHeight: 24 * 1.45, face: .system, tracking: 0)
        public static let pairingNumber = TypeToken(size: 54, weight: 700, lineHeight: nil, face: .rounded, tracking: 2)
        public static let hint = TypeToken(size: 17, weight: 400, lineHeight: 17 * 1.5, face: .system, tracking: 0)
    }

    public enum RuleSheet {
        public static let gap: CGFloat = 24
        public static let summaryPadding: CGFloat = 4
        public static let destructivePadding: CGFloat = 6
        public static let actionHeight: CGFloat = 48
        public static let actionPadding: CGFloat = 28
        public static let actionGap: CGFloat = 8
    }
}

public enum SignInLayout {
    public static let macWindowWidth: CGFloat = 460
    public static let macWindowHeight: CGFloat = 560
}
