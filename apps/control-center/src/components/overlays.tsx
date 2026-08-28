import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { nextRovingIndex } from "./collections.js";
import { ActionButton } from "./primitives.js";

export interface ModalDialogProps {
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly title: ReactNode;
}

export function ModalDialog({ children, closeLabel, onClose, open, title }: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      const initial = dialog.querySelector<HTMLElement>(
        "[data-autofocus], button, input, select, textarea, a[href]",
      );
      initial?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const restore = () => returnFocusRef.current?.focus();
    dialog.addEventListener("close", restore);
    return () => dialog.removeEventListener("close", restore);
  }, []);

  return (
    <dialog
      aria-labelledby={titleId}
      aria-modal="true"
      className="modal-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      ref={dialogRef}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <ActionButton aria-label={closeLabel} onClick={onClose} variant="quiet">
          ×
        </ActionButton>
      </div>
      {children}
    </dialog>
  );
}

export interface ActionMenuItem {
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: ReactNode;
  readonly onSelect: () => void;
}

export interface ActionMenuProps {
  readonly items: readonly ActionMenuItem[];
  readonly label: string;
}

export function ActionMenu({ items, label }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const focusItem = (index: number) => {
    const available = items
      .map((item, itemIndex) => ({ item, itemIndex }))
      .filter(({ item }) => !item.disabled);
    if (available.length === 0) return;
    const requested = available.find(({ itemIndex }) => itemIndex === index) ?? available[0];
    if (!requested) return;
    setActiveIndex(requested.itemIndex);
    queueMicrotask(() => itemRefs.current[requested.itemIndex]?.focus());
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    const enabledIndexes = items.flatMap((item, index) => (item.disabled ? [] : [index]));
    const currentEnabled = Math.max(0, enabledIndexes.indexOf(activeIndex));
    const nextEnabled = nextRovingIndex(
      currentEnabled,
      enabledIndexes.length,
      event.key,
      "vertical",
    );
    if (nextEnabled === currentEnabled) return;
    event.preventDefault();
    const nextIndex = enabledIndexes[nextEnabled];
    if (nextIndex !== undefined) focusItem(nextIndex);
  };

  return (
    <div className="action-menu">
      <ActionButton
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) focusItem(activeIndex);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            focusItem(event.key === "ArrowDown" ? 0 : items.length - 1);
          }
        }}
        ref={triggerRef}
        variant="secondary"
      >
        {label}
      </ActionButton>
      {open ? (
        <div className="menu-popover" id={menuId} onKeyDown={handleMenuKeyDown} role="menu">
          {items.map((item, index) => (
            <button
              disabled={item.disabled}
              key={item.id}
              onClick={() => {
                item.onSelect();
                close(true);
              }}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface TabDefinition {
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: ReactNode;
  readonly panel: ReactNode;
}

export interface TabsProps {
  readonly activeId: string;
  readonly label: string;
  readonly onChange: (id: string) => void;
  readonly tabs: readonly TabDefinition[];
}

export function Tabs({ activeId, label, onChange, tabs }: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeId),
  );

  const move = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const enabledIndexes = tabs.flatMap((tab, index) => (tab.disabled ? [] : [index]));
    const currentEnabled = Math.max(0, enabledIndexes.indexOf(currentIndex));
    const nextEnabled = nextRovingIndex(
      currentEnabled,
      enabledIndexes.length,
      event.key,
      "horizontal",
    );
    if (nextEnabled === currentEnabled) return;
    event.preventDefault();
    const nextIndex = enabledIndexes[nextEnabled];
    const nextTab = nextIndex === undefined ? undefined : tabs[nextIndex];
    if (!nextTab) return;
    onChange(nextTab.id);
    queueMicrotask(() => tabRefs.current[nextIndex as number]?.focus());
  };

  const active = tabs[activeIndex] ?? tabs[0];
  return (
    <div className="tabs">
      <div aria-label={label} role="tablist">
        {tabs.map((tab, index) => (
          <button
            aria-controls={`${baseId}-${tab.id}-panel`}
            aria-selected={tab.id === active?.id}
            disabled={tab.disabled}
            id={`${baseId}-${tab.id}-tab`}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => move(event, index)}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            role="tab"
            tabIndex={tab.id === active?.id ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active ? (
        <section
          aria-labelledby={`${baseId}-${active.id}-tab`}
          id={`${baseId}-${active.id}-panel`}
          role="tabpanel"
        >
          {active.panel}
        </section>
      ) : null}
    </div>
  );
}
