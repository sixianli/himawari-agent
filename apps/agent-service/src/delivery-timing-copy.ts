import type { DeliveryTimingConfiguration } from "@himawari-agent/application";

export type DeliveryTimingLocale = "zh-CN" | "en" | "ja";

interface Copy {
  readonly label: string;
  readonly description: string;
  readonly unit: string;
}

type Entry = Readonly<Record<DeliveryTimingLocale, Copy>>;

export const DELIVERY_TIMING_COPY: Readonly<Record<keyof DeliveryTimingConfiguration, Entry>> =
  Object.freeze({
    busyAtLeastPermille: {
      "zh-CN": {
        label: "判定为忙的把握",
        description: "判断模型认为你正忙的把握达到这个值，才先不推送。",
        unit: "‰",
      },
      en: {
        label: "Busy confidence",
        description: "Hold a notification only when the model is at least this sure you are busy.",
        unit: "‰",
      },
      ja: {
        label: "取り込み中と判断する確度",
        description: "取り込み中だとモデルがこの確度以上で判断したときだけ通知を保留します。",
        unit: "‰",
      },
    },
    recheckSeconds: {
      "zh-CN": {
        label: "复查间隔",
        description: "先不推送之后，隔多久再确认你有没有空。",
        unit: "秒",
      },
      en: {
        label: "Recheck interval",
        description: "How long to wait before checking again whether you are free.",
        unit: "s",
      },
      ja: {
        label: "再確認の間隔",
        description: "通知を保留したあと、手が空いたかをもう一度確認するまでの時間です。",
        unit: "秒",
      },
    },
    timeoutMs: {
      "zh-CN": {
        label: "判断超时",
        description: "判断模型超过这个时间没答，就直接推送。",
        unit: "毫秒",
      },
      en: {
        label: "Judgement timeout",
        description: "If the model does not answer within this time, the notification is sent.",
        unit: "ms",
      },
      ja: {
        label: "判断のタイムアウト",
        description: "モデルがこの時間内に答えないときは、そのまま通知します。",
        unit: "ミリ秒",
      },
    },
    perMinute: {
      "zh-CN": {
        label: "每分钟最多判断次数",
        description: "每分钟最多请判断模型判断几次，超过就直接推送。",
        unit: "次/分钟",
      },
      en: {
        label: "Judgements per minute",
        description:
          "At most this many model judgements per minute; beyond that, notifications are sent.",
        unit: "/min",
      },
      ja: {
        label: "1分あたりの判断回数",
        description: "1分あたりのモデル判断の上限です。超えた分はそのまま通知します。",
        unit: "回/分",
      },
    },
    reminderMaximumDeferSeconds: {
      "zh-CN": {
        label: "提醒最多扣多久",
        description: "到点的提醒最多先扣这么久，到时间一定推送。",
        unit: "秒",
      },
      en: {
        label: "Longest hold for reminders",
        description: "A due reminder is held at most this long, then always sent.",
        unit: "s",
      },
      ja: {
        label: "リマインダーを保留する最長時間",
        description: "時刻が来たリマインダーの保留はこの時間までで、その後は必ず通知します。",
        unit: "秒",
      },
    },
    maximumDeferSeconds: {
      "zh-CN": {
        label: "其他通知最多扣多久",
        description: "任务结果、邮件提醒等最多先扣这么久，到时间一定推送。",
        unit: "秒",
      },
      en: {
        label: "Longest hold for other notices",
        description: "Task results and mail notices are held at most this long, then always sent.",
        unit: "s",
      },
      ja: {
        label: "その他の通知を保留する最長時間",
        description: "タスク結果やメールの通知の保留はこの時間までで、その後は必ず通知します。",
        unit: "秒",
      },
    },
    speechFreshSeconds: {
      "zh-CN": {
        label: "说话信号多新才算数",
        description: "最近这么久内听到你在说话，才算你正在说话。",
        unit: "秒",
      },
      en: {
        label: "Speech signal freshness",
        description: "Speech heard within this time counts as you talking now.",
        unit: "s",
      },
      ja: {
        label: "会話の信号の鮮度",
        description: "この時間内に話し声を検知していれば、今話していると見なします。",
        unit: "秒",
      },
    },
    motionFreshSeconds: {
      "zh-CN": {
        label: "运动信号多新才算数",
        description: "最近这么久内的运动状态才算你现在的状态。",
        unit: "秒",
      },
      en: {
        label: "Motion signal freshness",
        description: "A motion state seen within this time counts as your current state.",
        unit: "s",
      },
      ja: {
        label: "動きの信号の鮮度",
        description: "この時間内の動きの状態を、今の状態と見なします。",
        unit: "秒",
      },
    },
    sleepFreshSeconds: {
      "zh-CN": {
        label: "睡眠信号多新才算数",
        description: "最近这么久内的睡眠状态才算你现在的状态。",
        unit: "秒",
      },
      en: {
        label: "Sleep signal freshness",
        description: "A sleep state seen within this time counts as your current state.",
        unit: "s",
      },
      ja: {
        label: "睡眠の信号の鮮度",
        description: "この時間内の睡眠の状態を、今の状態と見なします。",
        unit: "秒",
      },
    },
    focusFreshSeconds: {
      "zh-CN": {
        label: "专注模式信号多新才算数",
        description: "最近这么久内的专注模式状态才算你现在的状态。",
        unit: "秒",
      },
      en: {
        label: "Focus signal freshness",
        description: "A Focus mode state seen within this time counts as your current state.",
        unit: "s",
      },
      ja: {
        label: "集中モードの信号の鮮度",
        description: "この時間内の集中モードの状態を、今の状態と見なします。",
        unit: "秒",
      },
    },
    connectivityFreshSeconds: {
      "zh-CN": {
        label: "连接信号多新才算数",
        description: "最近这么久内的车载连接等状态才算你现在的状态。",
        unit: "秒",
      },
      en: {
        label: "Connection signal freshness",
        description: "A car or other connection state seen within this time counts as current.",
        unit: "s",
      },
      ja: {
        label: "接続の信号の鮮度",
        description: "この時間内の車載接続などの状態を、今の状態と見なします。",
        unit: "秒",
      },
    },
    macPresenceSeconds: {
      "zh-CN": {
        label: "Mac 多久没动算不在",
        description: "Mac 超过这么久没有键盘鼠标输入，通知就改发到 iPhone。",
        unit: "秒",
      },
      en: {
        label: "Mac away after",
        description:
          "After this long without keyboard or mouse input on the Mac, notifications go to the iPhone.",
        unit: "s",
      },
      ja: {
        label: "Macを離席と見なす時間",
        description: "Macでこの時間キーボードやマウスの操作がないと、通知はiPhoneに届きます。",
        unit: "秒",
      },
    },
  });

export const DELIVERY_TIMING_VALUE: Readonly<
  Record<
    keyof DeliveryTimingConfiguration,
    {
      readonly kind: "ratio" | "duration" | "count";
      readonly storageUnit: "permille" | "ms" | "s" | "count";
    }
  >
> = Object.freeze({
  busyAtLeastPermille: { kind: "ratio", storageUnit: "permille" },
  recheckSeconds: { kind: "duration", storageUnit: "s" },
  timeoutMs: { kind: "duration", storageUnit: "ms" },
  perMinute: { kind: "count", storageUnit: "count" },
  reminderMaximumDeferSeconds: { kind: "duration", storageUnit: "s" },
  maximumDeferSeconds: { kind: "duration", storageUnit: "s" },
  speechFreshSeconds: { kind: "duration", storageUnit: "s" },
  motionFreshSeconds: { kind: "duration", storageUnit: "s" },
  sleepFreshSeconds: { kind: "duration", storageUnit: "s" },
  focusFreshSeconds: { kind: "duration", storageUnit: "s" },
  connectivityFreshSeconds: { kind: "duration", storageUnit: "s" },
  macPresenceSeconds: { kind: "duration", storageUnit: "s" },
});
