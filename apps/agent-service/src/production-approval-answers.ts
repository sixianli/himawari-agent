import type { ApprovalRequest } from "@himawari-agent/application";
import type { InboxSourceRegistry, ProductionInbox } from "./production-inbox.js";

export const APPROVAL_ANSWER_EVENT_KIND = "approval_answer";

export function isApprovalAnswerEvent(sourceKind: string): boolean {
  return sourceKind === APPROVAL_ANSWER_EVENT_KIND;
}

export interface ProductionApprovalAnswersOptions {
  readonly threadOf: (runId: string) => Promise<string | null | undefined>;
  readonly mainThread: { read(): Promise<string | undefined> };
}

export class ProductionApprovalAnswers {
  readonly #options: ProductionApprovalAnswersOptions;
  #inbox: Pick<ProductionInbox, "submit"> | undefined;

  constructor(options: ProductionApprovalAnswersOptions) {
    this.#options = options;
  }

  registerSource(registry: InboxSourceRegistry): void {
    registry.register({
      kind: APPROVAL_ANSWER_EVENT_KIND,
      describe: "你对同意卡片的回答",
      externalContent: false,
      fromOwner: true,
      priority: 1,
      verbatim: true,
    });
  }

  attach(inbox: Pick<ProductionInbox, "submit">): void {
    this.#inbox = inbox;
  }

  async answered(approval: ApprovalRequest): Promise<void> {
    if (approval.status !== "approved" && approval.status !== "denied") return;
    const inbox = this.#inbox;
    if (!inbox) return;
    const threadId = await this.#options.threadOf(approval.runId);
    if (!threadId) return;
    const main = await this.#options.mainThread.read();
    await inbox.submit({
      sourceKind: APPROVAL_ANSWER_EVENT_KIND,
      sourceRef: approval.runId,
      sourceVersion: `${approval.id}:${approval.status}`,
      summary: approval.status,
      externalContent: false,
      threadId: threadId === main ? null : threadId,
    });
  }
}
