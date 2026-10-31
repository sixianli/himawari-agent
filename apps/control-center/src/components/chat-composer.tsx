import { type ReactNode, useEffect, useRef, useState } from "react";
import { isImageFile, prepareImage, rememberImage } from "../attachment-image.js";
import { ATTACHMENT_ACCEPT, extractAttachmentText } from "../attachment-text.js";
import {
  attachmentName,
  type DraftAttachment,
  draftBytes,
  formatBytes,
  joinDraft,
  MAX_ATTACHMENTS,
  MESSAGE_LIMIT_BYTES,
  splitDraft,
} from "../draft-attachments.js";
import type { AvailableModel } from "../gateway-client.js";
import type { MessageId } from "../i18n/message-ids.js";
import { LineIcon } from "./answer-footer.js";
import { AttachmentThumb } from "./attachment-thumb.js";
import { Glyph } from "./glyphs.js";
import { ModelPicker } from "./model-picker.js";
import { ActionButton, Field } from "./primitives.js";

type AttachmentError = "tooLarge" | "unsupported" | "empty" | "uploadFailed";

const ATTACHMENT_ERROR_MESSAGES: Readonly<Record<AttachmentError, MessageId>> = {
  tooLarge: "chat.attachmentTooLarge",
  unsupported: "chat.attachmentUnsupported",
  empty: "chat.attachmentEmpty",
  uploadFailed: "chat.attachmentUploadFailed",
};

const attachmentErrorOf = (caught: unknown): AttachmentError => {
  const code = caught instanceof Error ? caught.message : "";
  return code === "ATTACHMENT_TOO_LARGE"
    ? "tooLarge"
    : code === "ATTACHMENT_EMPTY"
      ? "empty"
      : code === "ATTACHMENT_UPLOAD_FAILED"
        ? "uploadFailed"
        : "unsupported";
};

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
  onUpload,
  readImage,
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
  readonly onUpload?: ((content: string, as: "text" | "image") => Promise<string>) | undefined;
  readonly readImage?: ((ref: string) => Promise<string>) | undefined;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [attachmentError, setAttachmentError] = useState<AttachmentError | "">("");
  const [reading, setReading] = useState<readonly { id: string; name: string; bytes: number }[]>(
    [],
  );
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const { text, files } = splitDraft(draft);
  const selectedModel = models.find((item) => item.ref === modelRef);
  const enabled =
    canSend && connected && !pending && !reading.length && (retryPending || Boolean(draft.trim()));
  const addFiles = (picked: readonly File[]) => {
    if (!picked.length || !onUpload) return;
    setAttachmentError("");
    if (
      splitDraft(latestDraft.current).files.length + reading.length + picked.length >
      MAX_ATTACHMENTS
    ) {
      setAttachmentError("tooLarge");
      return;
    }
    const jobs = picked.map((file) => ({
      id: crypto.randomUUID(),
      name: attachmentName(file.name),
      bytes: file.size,
      file,
    }));
    setReading((current) => [...current, ...jobs]);
    const upload = (content: string, as: "text" | "image") =>
      onUpload(content, as).catch(() => {
        throw new Error("ATTACHMENT_UPLOAD_FAILED");
      });
    const prepared = jobs.map((job) =>
      isImageFile(job.file)
        ? prepareImage(job.file).then(async ({ dataUrl, bytes }) => {
            const ref = await upload(dataUrl, "image");
            rememberImage(ref, dataUrl);
            return { name: job.name, ref, bytes, kind: "image" as const, truncated: false };
          })
        : extractAttachmentText(job.file).then(async ({ kind, text: content, truncated }) => {
            const ref = await upload(content, "text");
            return { name: job.name, ref, bytes: job.bytes, kind, truncated };
          }),
    );
    for (const promise of prepared) promise.catch(() => undefined);
    void jobs.reduce(
      (previous, job, index) =>
        previous.then(() =>
          (prepared[index] as Promise<DraftAttachment>)
            .then((attachment) => {
              if (!mounted.current) return;
              const current = splitDraft(latestDraft.current);
              const next = joinDraft(current.text, [...current.files, attachment]);
              if (draftBytes(next) > MESSAGE_LIMIT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
              latestDraft.current = next;
              onDraft(next);
            })
            .catch((caught: unknown) => {
              if (mounted.current) setAttachmentError(attachmentErrorOf(caught));
            })
            .finally(() => {
              if (mounted.current)
                setReading((current) => current.filter((item) => item.id !== job.id));
            }),
        ),
      Promise.resolve(),
    );
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
        {files.length || reading.length ? (
          <ul className="attachment-chips">
            {files.map((file, index) => (
              <li
                key={`${index}:${file.ref}`}
                className={file.kind === "image" ? "is-image" : undefined}
                title={
                  file.kind === "image" ? `${file.name} · ${formatBytes(file.bytes)}` : undefined
                }
              >
                {file.kind === "image" ? (
                  <AttachmentThumb imageRef={file.ref} name={file.name} readImage={readImage} />
                ) : (
                  <>
                    <LineIcon name="file" />
                    <span className="attachment-name">{file.name}</span>
                    <small>{formatBytes(file.bytes)}</small>
                  </>
                )}
                {file.truncated ? (
                  <small
                    className="attachment-truncated"
                    title={message("chat.attachmentTruncated")}
                  >
                    {message("chat.attachmentTruncatedShort")}
                  </small>
                ) : null}
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
                  <Glyph name="close" size={14} />
                </button>
              </li>
            ))}
            {reading.map((item) => (
              <li key={item.id} className="is-reading" aria-busy="true">
                <span className="attachment-spinner" aria-hidden="true" />
                <span className="attachment-name">{item.name}</span>
                <small>{message("chat.attachmentReading")}</small>
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
        {files.some((file) => file.kind === "image") && selectedModel?.images === false ? (
          <p className="attachment-note">
            {message("chat.imageUnsupported", { model: selectedModel.name })}
          </p>
        ) : null}
        {attachmentError ? (
          <p role="alert" className="attachment-error">
            {message(ATTACHMENT_ERROR_MESSAGES[attachmentError])}
          </p>
        ) : null}
        <div className="composer-tools">
          <input
            ref={fileRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
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
            disabled={!onUpload}
            onClick={() => fileRef.current?.click()}
            variant="quiet"
            className="attach-button"
          >
            <Glyph className="send-icon" name="plus" />
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
              <Glyph className="send-icon" name="stop" />
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
              <Glyph className="send-icon" name="send" />
            </ActionButton>
          )}
        </div>
      </form>
      {retryPending && !pending ? (
        <output className="composer-readiness">{message("review.pendingSend")}</output>
      ) : null}
    </>
  );
}
