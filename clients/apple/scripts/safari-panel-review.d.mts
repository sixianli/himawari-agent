import type { BrowserContext, Page } from "@playwright/test";

export interface PanelTab {
  readonly url: string;
  readonly title: string;
  readonly text?: string;
}

export interface PanelHand {
  readonly phase: string;
  readonly done: boolean;
  readonly line?: string;
  readonly button?: string;
  readonly link?: string;
}

export interface PanelScene {
  readonly open: Readonly<Record<string, unknown>>;
  readonly page: PanelTab | null;
  readonly tab?: PanelTab;
  readonly typed?: string;
  readonly hand?: PanelHand;
}

export function strings(language: string): Record<string, string>;
export function scenes(words: Record<string, string>): Record<string, PanelScene>;
export function unreachableWord(): string;
export function routePanel(context: BrowserContext): Promise<void>;
export function openPanel(
  context: BrowserContext,
  scene: PanelScene,
  words: Record<string, string>,
  unreachable: string,
): Promise<Page>;
