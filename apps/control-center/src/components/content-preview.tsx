import { useEffect, useRef } from "react";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { ActionButton } from "./primitives.js";
export interface ContentPreviewValue {
  readonly title: string;
  readonly text: string;
}
/** Shows only text already authorized for this conversation; never reads a path. */
export function ContentPreview({
  value,
  onClose,
}: {
  value: ContentPreviewValue;
  onClose: () => void;
}) {
  const { message } = useControlCenterIntl();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    panel.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <aside
      className="content-preview"
      ref={panel}
      tabIndex={-1}
      aria-label={value.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <strong>{value.title}</strong>
        <ActionButton variant="quiet" aria-label={message("common.close")} onClick={onClose}>
          ×
        </ActionButton>
      </header>
      <pre>{value.text}</pre>
    </aside>
  );
}
