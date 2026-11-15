export type WalkthroughRole =
  | "alert"
  | "article"
  | "button"
  | "checkbox"
  | "dialog"
  | "link"
  | "navigation"
  | "region"
  | "searchbox"
  | "switch"
  | "tab"
  | "tablist"
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
  settledTurn: ".chat-turn:not(.chat-turn-outgoing)",
  message: { role: "article" },
  turnProcess: ".turn-process",
  turnProcessToggle: ":scope > summary",
  openSettings: { role: "button", name: "设置", exact: true },
  settingsDialog: { role: "dialog" },
  settingsToolsTab: { role: "button", name: "工具与权限", exact: true },
  closeSettings: { role: "button", name: "关闭" },
  settingsTabs: { role: "navigation", name: "设置类别", exact: true },
  settingsTab: { role: "button" },
  showList: { role: "button", name: "显示列表", exact: true },
  searchEnable: { role: "switch", name: "允许联网搜索", exact: true },
  searchRevoke: { role: "switch", name: "撤销联网搜索授权", exact: true },
  searchStep: "搜索网页",
  commandStep: "运行命令",
  memoryFoundStep: /条相关记忆/,
  approveOnce: { role: "button", name: "允许这一次" },
  approveSearch: { role: "button", name: "允许联网搜索", exact: true },
  rememberSearch: { role: "checkbox", name: "记住我的选择，之后允许联网搜索", exact: true },
  searchBatch: /这一步要搜索 \d+ 次，一次允许就都放行。/,
  approvalContinuing: "已收到，正在继续…",
  stillLoading: "正在加载…",
  sidebarNavigation: { role: "navigation", name: "对话" },
  openMemory: { role: "button", name: "记忆", exact: true },
  memoryPage: { role: "region", name: "记忆", exact: true },
  memoryCount: /^记忆\s*\d+$/,
  openExport: { role: "button", name: "导出记忆和规则", exact: true },
  downloadExport: { role: "button", name: "下载导出文件", exact: true },
  exportDone: /已导出 \d+ 条记忆、\d+ 条正在执行的长期规则；\d+ 处敏感内容只留了占位符。/,
  memoryTabs: { role: "tablist", name: "记忆", exact: true },
  memoryTab: { role: "tab" },
  memoryCarry: { role: "region", name: "每次对话都会带上的记忆", exact: true },
  pageError: { role: "alert" },
  openReminders: { role: "button", name: "提醒" },
  remindersPage: { role: "region", name: "提醒", exact: true },
  openFiles: { role: "button", name: "文件", exact: true },
  filesPage: { role: "region", name: "文件", exact: true },
  threadSearch: { role: "searchbox", name: "搜索对话", exact: true },
  threadSearchResult: ".thread-sidebar-records .thread-search-results li",
  filesLibrary: ".files-library",
  modelPickerRoot: ".model-picker",
  modelPicker: ".model-picker > summary",
  modelChooser: ".model-panel .picker-model-name",
  modelOption: ".model-options button",
  modelMore: ".model-options .model-more",
  unreadableRecords: "部分执行记录暂不可读取",
  failedConversation: "暂时无法加载这段对话，请重试。",
  writingProgress: /已写 (\d+) 行/,
  noProcessRecords: "没有可展示的过程记录",
} as const satisfies Record<
  string,
  WalkthroughTarget | readonly WalkthroughTarget[] | string | RegExp
>);
