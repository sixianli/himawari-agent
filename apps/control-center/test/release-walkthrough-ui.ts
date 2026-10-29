export type WalkthroughRole =
  | "alert"
  | "article"
  | "button"
  | "dialog"
  | "link"
  | "navigation"
  | "region"
  | "switch"
  | "textbox";

export type WalkthroughTarget = Readonly<{
  role: WalkthroughRole;
  name?: string;
  exact?: boolean;
}>;

export const RELEASE_WALKTHROUGH_UI = Object.freeze({
  composer: { role: "textbox", name: "消息草稿", exact: true },
  send: { role: "button", name: "发送", exact: true },
  stop: { role: "button", name: "停止", exact: true },
  newThread: [
    { role: "link", name: "新建对话" },
    { role: "button", name: "新建对话" },
  ],
  conversationLoading: '.thread-loading-skeleton[data-scope="conversation"]',
  turn: ".chat-turn",
  message: { role: "article" },
  turnProcess: ".turn-process",
  turnProcessToggle: ":scope > summary",
  openSettings: { role: "button", name: "设置", exact: true },
  settingsDialog: { role: "dialog" },
  settingsToolsTab: { role: "button", name: "工具与权限", exact: true },
  closeSettings: { role: "button", name: "关闭" },
  searchEnable: { role: "switch", name: "允许联网搜索", exact: true },
  searchRevoke: { role: "switch", name: "撤销联网搜索授权", exact: true },
  searchStep: "搜索网页",
  commandStep: "运行命令",
  approveOnce: { role: "button", name: "允许这一次" },
  stillLoading: "正在加载…",
  sidebarNavigation: { role: "navigation", name: "对话" },
  openMemory: { role: "button", name: "记忆", exact: true },
  memoryPage: { role: "region", name: "记忆", exact: true },
  memorySummary: /记住了 \d+ 条关于你的事/,
  memoryBack: { role: "button", name: "返回", exact: true },
  pageError: { role: "alert" },
  unreadableRecords: "部分执行记录暂不可读取",
  noProcessRecords: "没有可展示的过程记录",
} as const satisfies Record<
  string,
  WalkthroughTarget | readonly WalkthroughTarget[] | string | RegExp
>);
