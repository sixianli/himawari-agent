export const ANSWER_OPENING = "好的，我收到了";
export const ANSWER_ENDING = "这就是全部回答。";
export const LONG_REQUEST = "请写长回答";

const DEFAULT_BODY = [
  "我先把要点说清楚。",
  "第一，这一句是逐字送出来的。",
  "第二，手机应该一边收一边显示，而不是等全部收完。",
  "第三，回答结束后这条消息只出现一次。",
];

export function e2eAnswer(ownerText: string): string {
  const text = ownerText.trim();
  if (text.startsWith(LONG_REQUEST)) {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `- 第 ${index + 1} 行：用来把对话撑长，好测滚动。`,
    );
    return [`${ANSWER_OPENING}“${text}”。`, "", ...lines, "", ANSWER_ENDING].join("\n");
  }
  return [`${ANSWER_OPENING}“${text}”。`, ...DEFAULT_BODY, ANSWER_ENDING].join("");
}
