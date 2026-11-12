import { fixedPrompt } from "./entry.js";

export const PROCESS_ACTIVITY_ICONS = Object.freeze([
  "bulb",
  "affiliate",
  "pencil-plus",
  "list-check",
  "history",
  "stack-2",
  "calendar",
  "bell",
  "mail",
  "message-2",
  "phone",
  "clipboard-list",
  "train",
  "car",
  "walk",
  "plane",
  "map-pin",
  "cloud",
  "world-search",
  "world",
  "file-text",
  "file-pencil",
  "table",
  "photo",
  "terminal-2",
  "calculator",
  "credit-card",
  "download",
  "users",
  "puzzle",
  "ear",
  "eye",
  "current-location",
  "heartbeat",
  "device-mobile",
  "home-bolt",
] as const);

export type ProcessActivityIcon = (typeof PROCESS_ACTIVITY_ICONS)[number];

export const PROCESS_ACTIVITY_FALLBACK_ICON: ProcessActivityIcon = "puzzle";
export const PROCESS_ACTIVITY_MAX_LENGTH = 80;
export const TOOL_ACTIVITY_PARAMETER_NAME = "activity";
export const TOOL_ACTIVITY_ICON_PARAMETER_NAME = "activityIcon";

export const TOOL_ACTIVITY_PARAMETER = fixedPrompt({
  id: "tools.activity-parameter",
  purpose: "每个工具都有的可选参数 activity 的说明：这一步在做什么，显示在主人看到的过程行上",
  usedBy: ["packages/runtime-pi/src/tool-activity.ts"],
  layer: "tools",
  output: "free-text",
  text: "可选。用回答的语言写一句话告诉主人这一步在做什么，说事情本身，不写工具名，例如“查东京明天的天气”。不超过 30 个字，不影响工具执行。",
});

export const TOOL_ACTIVITY_ICON_PARAMETER = fixedPrompt({
  id: "tools.activity-icon-parameter",
  purpose: "每个工具都有的可选参数 activityIcon 的说明：从系统提示里的图标表挑一个",
  usedBy: ["packages/runtime-pi/src/tool-activity.ts"],
  layer: "tools",
  output: "free-text",
  text: "可选。和 activity 一起给，从系统提示“过程图标”一节的名字里挑最贴近这一步的一个，原样照抄；都不贴近时用 puzzle。",
});

export const CHAT_PROCESS_ICONS_SECTION = fixedPrompt({
  id: "chat.process-icons-section",
  purpose: "系统提示里列出 activityIcon 可选图标名的一节，整段只出现一次",
  usedBy: ["packages/runtime-pi/src/tool-activity.ts"],
  layer: "system",
  output: "free-text",
  text: [
    "过程图标：调用任何工具时，都可以顺带给 activity（一句话说这一步在做什么）和 activityIcon（下面的名字之一），主人会在过程行上看到它们。",
    "- 想和记：bulb 想办法，affiliate 找关联，pencil-plus 记下新的事，list-check 核对清单，history 回看以前，stack-2 整理一批东西",
    "- 日程和消息：calendar 日程，bell 提醒，mail 邮件，message-2 消息，phone 电话，clipboard-list 待办",
    "- 出门：train 电车，car 开车或打车，walk 步行，plane 航班，map-pin 地点，cloud 天气",
    "- 上网和文件：world-search 搜索网页，world 打开网页，file-text 读文件，file-pencil 改文件，table 表格，photo 图片",
    "- 动手做：terminal-2 运行命令，calculator 计算，credit-card 付款或账单，download 下载，users 联系人或别人，puzzle 其他",
    "- 设备和感知：ear 听，eye 看，current-location 当前位置，heartbeat 健康数据，device-mobile 手机，home-bolt 家里的设备",
  ].join("\n"),
});
