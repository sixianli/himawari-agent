import type { KeyboardEvent, ReactNode } from "react";

export function nextRovingIndex(
  current: number,
  itemCount: number,
  key: string,
  orientation: "horizontal" | "vertical",
): number {
  if (itemCount < 1) return -1;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  const previous = orientation === "horizontal" ? key === "ArrowLeft" : key === "ArrowUp";
  const next = orientation === "horizontal" ? key === "ArrowRight" : key === "ArrowDown";
  if (previous) return (current - 1 + itemCount) % itemCount;
  if (next) return (current + 1) % itemCount;
  return current;
}

export interface SemanticListProps<T> {
  readonly empty: ReactNode;
  readonly getId: (item: T) => string;
  readonly items: readonly T[];
  readonly label: string;
  readonly renderItem: (item: T, index: number) => ReactNode;
}

export function SemanticList<T>({ empty, getId, items, label, renderItem }: SemanticListProps<T>) {
  return items.length > 0 ? (
    <ul aria-label={label} className="semantic-list">
      {items.map((item, index) => (
        <li key={getId(item)}>{renderItem(item, index)}</li>
      ))}
    </ul>
  ) : (
    <p className="empty-state">{empty}</p>
  );
}

export interface DataTableColumn<T> {
  readonly header: ReactNode;
  readonly id: string;
  readonly render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  readonly caption: string;
  readonly columns: readonly DataTableColumn<T>[];
  readonly getRowId: (row: T) => string;
  readonly rows: readonly T[];
}

export function DataTable<T>({ caption, columns, getRowId, rows }: DataTableProps<T>) {
  return (
    <div className="table-scroll">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowId(row)}>
              {columns.map((column) => (
                <td key={column.id}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface VirtualizedListProps<T> {
  readonly activeIndex: number;
  readonly getId: (item: T) => string;
  readonly getLabel: (item: T) => string;
  readonly items: readonly T[];
  readonly label: string;
  readonly onActiveIndexChange: (index: number) => void;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly totalCount: number;
  readonly windowStart: number;
}

export function VirtualizedList<T>({
  activeIndex,
  getId,
  getLabel,
  items,
  label,
  onActiveIndexChange,
  renderItem,
  totalCount,
  windowStart,
}: VirtualizedListProps<T>) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextRovingIndex(activeIndex, totalCount, event.key, "vertical");
    if (next === activeIndex) return;
    event.preventDefault();
    onActiveIndexChange(next);
  };
  return (
    <div
      aria-activedescendant={
        items[activeIndex - windowStart]
          ? `virtual-${getId(items[activeIndex - windowStart] as T)}`
          : undefined
      }
      aria-label={label}
      className="virtual-list"
      onKeyDown={handleKeyDown}
      role="listbox"
      tabIndex={0}
    >
      {items.map((item, index) => {
        const absoluteIndex = windowStart + index;
        return (
          <div
            aria-label={getLabel(item)}
            aria-posinset={absoluteIndex + 1}
            aria-selected={absoluteIndex === activeIndex}
            aria-setsize={totalCount}
            id={`virtual-${getId(item)}`}
            key={getId(item)}
            role="option"
            tabIndex={-1}
          >
            {renderItem(item, absoluteIndex)}
          </div>
        );
      })}
    </div>
  );
}
