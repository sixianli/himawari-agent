import { useEffect, useRef, useState } from "react";
import type { AvailableModel } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { ModelPicker } from "./model-picker.js";
import { ActionButton, Field } from "./primitives.js";

export async function appendTextAttachment(draft: string, file: File): Promise<string> {
  if (file.size > 64 * 1024) throw new Error("TEXT_ATTACHMENT_TOO_LARGE");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  if (
    [...text].some((character) => {
      const code = character.charCodeAt(0);
      return code < 9 || (code > 13 && code < 32);
    })
  )
    throw new Error("TEXT_ATTACHMENT_INVALID");
  const name = file.name.replace(/[\r\n]/g, " ");
  const next = `${draft}${draft ? "\n\n" : ""}[${name}]\n${text}`;
  if (new TextEncoder().encode(next).length > 64 * 1024)
    throw new Error("TEXT_ATTACHMENT_TOO_LARGE");
  return next;
}

export function ChatComposer({
  draft,
  onDraft,
  onSubmit,
  connected,
  pending,
  model,
  models,
  modelRef,
  thinkingLevel,
  onModelChange,
  onThinkingChange,
  onStop,
  message,
  canSend = true,
}: {
  readonly draft: string;
  readonly onDraft: (draft: string) => void;
  readonly onSubmit: () => void;
  readonly connected: boolean;
  readonly pending: boolean;
  readonly model: string | undefined;
  readonly models: readonly AvailableModel[];
  readonly modelRef: string;
  readonly thinkingLevel: string;
  readonly onModelChange: (ref: string) => void;
  readonly onThinkingChange: (level: string) => void;
  readonly onStop?: (() => void) | undefined;
  readonly message: (id: MessageId) => string;
  readonly canSend?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [attachmentError, setAttachmentError] = useState(false);
  const [reading, setReading] = useState(false);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const enabled = canSend && connected && !pending && !reading && Boolean(draft.trim());
  return (
    <>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (enabled) onSubmit();
        }}
      >
        <Field label={message("threads.draft")}>
          <textarea
            rows={2}
            value={draft}
            placeholder={message("chat.placeholder")}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey
              ) {
                event.preventDefault();
                if (enabled) onSubmit();
              }
            }}
          />
        </Field>
        {attachmentError ? (
          <p role="alert" className="attachment-list">
            {message("chat.attachmentError")}
          </p>
        ) : null}
        <div className="composer-tools">
          <input
            ref={fileRef}
            type="file"
            accept="text/*,.md,.csv,.json,.yaml,.yml,.ts,.tsx,.js,.py,.log"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setReading(true);
              setAttachmentError(false);
              void appendTextAttachment("", file)
                .then((attachment) => {
                  if (!mounted.current) return;
                  const next = `${latestDraft.current}${latestDraft.current ? "\n\n" : ""}${attachment}`;
                  if (new TextEncoder().encode(next).length > 64 * 1024)
                    throw new Error("TEXT_ATTACHMENT_TOO_LARGE");
                  onDraft(next);
                })
                .catch(() => {
                  if (mounted.current) setAttachmentError(true);
                })
                .finally(() => {
                  if (mounted.current) setReading(false);
                });
            }}
          />
          <ActionButton
            aria-label={message("chat.attach")}
            title={message("chat.attach")}
            disabled={reading}
            onClick={() => fileRef.current?.click()}
            variant="quiet"
          >
            ＋
          </ActionButton>
          <span className="execution-mode">{message("chat.execute")}</span>
          {models.length ? (
            <div className="model-selection">
              <ModelPicker
                models={models}
                modelRef={modelRef}
                thinkingLevel={thinkingLevel}
                onModelChange={onModelChange}
                onThinkingChange={onThinkingChange}
                message={message}
              />
            </div>
          ) : (
            <span className="model-selection">{model ?? message("chat.modelUnavailable")}</span>
          )}
          {onStop ? (
            <ActionButton
              className="stop-button"
              aria-label={message("chat.stop")}
              disabled={!connected || pending}
              onClick={onStop}
              variant="secondary"
            >
              ■
            </ActionButton>
          ) : null}
          <ActionButton
            className="send-button"
            aria-label={message("threads.send")}
            disabled={!enabled}
            pending={pending}
            type="submit"
          >
            ↑
          </ActionButton>
        </div>
      </form>
      <div className="composer-hint">
        <span>{message("chat.permission")}</span>
        <span className="keyboard-hint">{message("chat.keyboard")}</span>
      </div>
    </>
  );
}
