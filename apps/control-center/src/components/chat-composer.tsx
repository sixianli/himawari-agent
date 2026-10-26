import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  ATTACHMENT_LIMIT_BYTES,
  type DraftAttachment,
  draftBytes,
  formatBytes,
  joinDraft,
  readAttachment,
  splitDraft,
} from "../draft-attachments.js";
import type { AvailableModel } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { LineIcon } from "./answer-footer.js";
import { ModelPicker } from "./model-picker.js";
import { ActionButton, Field } from "./primitives.js";

const MAX_ATTACHMENTS = 10;

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
  retryPending = false,
  environment,
  fresh = false,
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
  readonly message: (id: MessageId, values?: Record<string, string | number>) => string;
  readonly canSend?: boolean;
  readonly retryPending?: boolean;
  readonly environment?: ReactNode;
  readonly fresh?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [attachmentError, setAttachmentError] = useState<"" | "tooLarge" | "unsupported">("");
  const [reading, setReading] = useState(false);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const { text, files } = splitDraft(draft);
  const enabled =
    canSend && connected && !pending && !reading && (retryPending || Boolean(draft.trim()));
  const addFiles = (picked: readonly File[]) => {
    if (!picked.length) return;
    setReading(true);
    setAttachmentError("");
    void Promise.all(picked.map(readAttachment))
      .then((read: DraftAttachment[]) => {
        if (!mounted.current) return;
        const current = splitDraft(latestDraft.current);
        const next = joinDraft(current.text, [...current.files, ...read]);
        if (
          current.files.length + read.length > MAX_ATTACHMENTS ||
          draftBytes(next) > ATTACHMENT_LIMIT_BYTES
        )
          throw new Error("ATTACHMENT_TOO_LARGE");
        onDraft(next);
      })
      .catch((caught: unknown) => {
        if (!mounted.current) return;
        setAttachmentError(
          caught instanceof Error && caught.message === "ATTACHMENT_TOO_LARGE"
            ? "tooLarge"
            : "unsupported",
        );
      })
      .finally(() => {
        if (mounted.current) setReading(false);
      });
  };
  return (
    <>
      {environment}
      <form
        className="composer"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          addFiles([...event.dataTransfer.files]);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (enabled) onSubmit();
        }}
      >
        {files.length ? (
          <ul className="attachment-chips">
            {files.map((file, index) => (
              <li key={`${index}:${file.name}`}>
                <LineIcon name="file" />
                <span className="attachment-name">{file.name}</span>
                <small>{formatBytes(draftBytes(file.text))}</small>
                <button
                  type="button"
                  aria-label={message("chat.removeAttachment", { name: file.name })}
                  title={message("chat.removeAttachment", { name: file.name })}
                  onClick={() =>
                    onDraft(
                      joinDraft(
                        text,
                        files.filter((_, item) => item !== index),
                      ),
                    )
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <Field label={message("threads.draft")}>
          <textarea
            rows={2}
            value={text}
            placeholder={message(fresh ? "chat.placeholderNew" : "chat.placeholder")}
            onChange={(event) => onDraft(joinDraft(event.target.value, files))}
            onPaste={(event) => {
              if (!event.clipboardData.files.length) return;
              event.preventDefault();
              addFiles([...event.clipboardData.files]);
            }}
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
          <p role="alert" className="attachment-error">
            {message(
              attachmentError === "tooLarge"
                ? "chat.attachmentTooLarge"
                : "chat.attachmentUnsupported",
            )}
          </p>
        ) : null}
        <div className="composer-tools">
          <input
            ref={fileRef}
            type="file"
            accept="text/*,.txt,.md,.csv,.tsv,.json,.yaml,.yml,.toml,.ini,.xml,.html,.css,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql,.log"
            multiple
            hidden
            onChange={(event) => {
              const picked = [...(event.target.files ?? [])];
              event.target.value = "";
              addFiles(picked);
            }}
          />
          <ActionButton
            aria-label={message("chat.attach")}
            title={message("chat.attachHint")}
            disabled={reading}
            onClick={() => fileRef.current?.click()}
            variant="quiet"
          >
            ＋
          </ActionButton>
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
          {onStop && !retryPending ? (
            <ActionButton
              className="stop-button"
              aria-label={message("chat.stop")}
              disabled={!connected || pending}
              onClick={onStop}
              variant="secondary"
            >
              ■
            </ActionButton>
          ) : (
            <ActionButton
              className="send-button"
              aria-label={message(retryPending ? "review.retrySend" : "threads.send")}
              title={`${message(retryPending ? "review.retrySend" : "threads.send")} · ${message("chat.keyboard")}`}
              disabled={!enabled}
              pending={pending}
              type="submit"
            >
              ↑
            </ActionButton>
          )}
        </div>
      </form>
      {retryPending && !pending ? (
        <output className="composer-readiness">{message("review.pendingSend")}</output>
      ) : null}
      {fresh ? (
        <div className="composer-hint">
          <span className="composer-permission">{message("chat.permission")}</span>
        </div>
      ) : null}
    </>
  );
}
