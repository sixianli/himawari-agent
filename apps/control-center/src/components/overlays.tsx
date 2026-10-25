import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import { createPortal } from "react-dom";
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

  const dialog = (
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
  // Mobile layouts hide inactive panes. Mount the modal outside those panes
  // so a dialog opened from the details drawer stays visible and focusable.
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

export interface ActionMenuItem {
  readonly disabled?: boolean;
  readonly id: string;
  readonly label: ReactNode;
  readonly onSelect: () => void;
}

export interface ActionMenuProps {
  readonly items: readonly ActionMenuItem[];
  readonly label: ReactNode;
}

export function ActionMenu({ items, label }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (anchor && menu)
      setPosition({
        left: Math.max(8, Math.min(anchor.right - menu.width, window.innerWidth - menu.width - 8)),
        top:
          anchor.bottom + menu.height + 8 <= window.innerHeight
            ? anchor.bottom + 4
            : Math.max(8, anchor.top - menu.height - 4),
      });
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        menuRef.current?.contains(event.target) ||
        triggerRef.current?.contains(event.target)
      )
        return;
      setOpen(false);
    };
    const reposition = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

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
      {open
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                left: position.left,
                top: position.top,
                right: "auto",
                zIndex: 80,
              }}
              className="menu-popover thread-context-menu"
              id={menuId}
              onKeyDown={handleMenuKeyDown}
              role="menu"
            >
              {items.map((item, index) => (
                <button
                  disabled={item.disabled}
                  key={item.id}
                  onClick={() => {
                    close(false);
                    triggerRef.current?.focus();
                    item.onSelect();
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
            </div>,
            document.body,
          )
        : null}
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
