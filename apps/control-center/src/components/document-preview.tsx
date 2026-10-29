import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import { useControlCenterIntl } from "../i18n/runtime.js";
import { type SheetCellStyle, type SheetView, workbookViews } from "../spreadsheet-model.js";

export type DocumentKind = "pdf" | "word" | "sheet";

type Message = ReturnType<typeof useControlCenterIntl>["message"];

const PAGE_GAP = 12;
const PAGE_PADDING = 12;
const RENDER_MARGIN = "800px 0px";
const HEADER_ROW_HEIGHT = 22;
const DEFAULT_ROW_HEIGHT = 21;
const SAFE_LINK = /^(https?:|mailto:)/i;

function useWidth(host: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(Math.floor(element.clientWidth / 4) * 4));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [host]);
  return width;
}

let pdfModule: Promise<typeof import("pdfjs-dist")> | undefined;
function loadPdf() {
  pdfModule ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([pdf, worker]) => {
    if (!pdf.GlobalWorkerOptions.workerSrc) pdf.GlobalWorkerOptions.workerSrc = worker.default;
    return pdf;
  });
  return pdfModule;
}

interface PageSize {
  readonly width: number;
  readonly height: number;
}

function PdfPage({
  document,
  number,
  size,
  width,
  label,
}: {
  readonly document: PDFDocumentProxy;
  readonly number: number;
  readonly size: PageSize;
  readonly width: number;
  readonly label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const scale = width / size.width;
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { root: element.closest(".preview-body"), rootMargin: RENDER_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const target = canvas.current;
    const layer = text.current;
    if (!visible || !target || !layer || width <= 0) return;
    let current = true;
    let task: RenderTask | undefined;
    void (async () => {
      const [pdf, page] = await Promise.all([loadPdf(), document.getPage(number)]);
      if (!current) return;
      const viewport = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      const context = target.getContext("2d");
      if (!context) return;
      task = page.render({
        canvas: target,
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await task.promise;
      if (!current) return;
      layer.replaceChildren();
      layer.style.setProperty("--total-scale-factor", String(scale));
      await new pdf.TextLayer({
        textContentSource: (page as PDFPageProxy).streamTextContent(),
        container: layer,
        viewport,
      }).render();
    })().catch(() => {});
    return () => {
      current = false;
      task?.cancel();
    };
  }, [visible, document, number, scale, width]);
  return (
    <div
      className="preview-page"
      ref={box}
      role="img"
      aria-label={label}
      style={{ width, height: Math.round(size.height * scale) }}
    >
      <canvas ref={canvas} />
      <div className="textLayer" ref={text} />
    </div>
  );
}

function PdfDocument({
  data,
  message,
  onFailed,
}: {
  readonly data: ArrayBuffer;
  readonly message: Message;
  readonly onFailed: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const width = useWidth(host);
  const [loaded, setLoaded] = useState<{
    readonly document: PDFDocumentProxy;
    readonly sizes: readonly PageSize[];
  }>();
  useEffect(() => {
    let current = true;
    let destroy: (() => Promise<void>) | undefined;
    void (async () => {
      const pdf = await loadPdf();
      const task = pdf.getDocument({ data: new Uint8Array(data.slice(0)) });
      destroy = () => task.destroy();
      const document = await task.promise;
      const sizes: PageSize[] = [];
      for (let number = 1; number <= document.numPages; number += 1) {
        const viewport = (await document.getPage(number)).getViewport({ scale: 1 });
        sizes.push({ width: viewport.width, height: viewport.height });
      }
      if (current) setLoaded({ document, sizes });
    })().catch(() => current && onFailed());
    return () => {
      current = false;
      void destroy?.();
    };
  }, [data, onFailed]);
  const pageWidth = Math.max(0, width - PAGE_PADDING * 2);
  return (
    <div className="preview-pages" ref={host} style={{ gap: PAGE_GAP, padding: PAGE_PADDING }}>
      {loaded && pageWidth > 0
        ? loaded.sizes.map((size, index) => (
            <PdfPage
              key={`page-${index + 1}`}
              document={loaded.document}
              number={index + 1}
              size={size}
              width={pageWidth}
              label={message("preview.page", { page: index + 1, count: loaded.sizes.length })}
            />
          ))
        : null}
    </div>
  );
}

const WORD_PAGE_CSS = `
:host { display: block; }
.docx-wrapper { background: transparent !important; padding: ${PAGE_PADDING}px !important; display: flex; flex-direction: column; align-items: center; gap: ${PAGE_GAP}px; }
.docx-wrapper > section.docx { margin: 0 !important; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18) !important; }
`;

const SYMBOL_FONT_BULLETS: Readonly<Record<string, string>> = {
  "\uF0A7": "\u25AA",
  "\uF0A8": "\u25A1",
  "\uF0D8": "\u27A2",
  "\uF0FC": "\u2713",
  "\uF076": "\u2756",
  "\uF06F": "o",
};

function stylesheet(text: string): CSSStyleSheet | undefined {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      text.replace(/[\uF020-\uF0FF]/g, (symbol) => SYMBOL_FONT_BULLETS[symbol] ?? "\u2022"),
    );
    return sheet;
  } catch {
    return undefined;
  }
}

function keepSafeLinks(root: ParentNode) {
  for (const link of root.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    if (!SAFE_LINK.test(href)) {
      link.removeAttribute("href");
      continue;
    }
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
}

function WordDocument({
  data,
  onFailed,
}: {
  readonly data: ArrayBuffer;
  readonly onFailed: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const width = useWidth(host);
  const [rendered, setRendered] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let current = true;
    void (async () => {
      const { renderAsync } = await import("docx-preview");
      const body = document.createElement("div");
      const styles = document.createElement("div");
      await renderAsync(data.slice(0), body, styles, {
        className: "docx",
        inWrapper: true,
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        renderComments: false,
        renderChanges: false,
        renderAltChunks: false,
        useBase64URL: true,
        experimental: false,
      });
      if (!current) return;
      keepSafeLinks(body);
      const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
      shadow.adoptedStyleSheets = [
        ...[...styles.querySelectorAll("style")].map((style) => style.textContent ?? ""),
        WORD_PAGE_CSS,
      ]
        .map(stylesheet)
        .filter((sheet): sheet is CSSStyleSheet => sheet !== undefined);
      shadow.replaceChildren(...body.childNodes);
      setRendered((count) => count + 1);
    })().catch(() => current && onFailed());
    return () => {
      current = false;
    };
  }, [data, onFailed]);
  useEffect(() => {
    void rendered;
    const wrapper = host.current?.shadowRoot?.querySelector<HTMLElement>(".docx-wrapper");
    const page = wrapper?.querySelector<HTMLElement>("section.docx");
    if (!wrapper || !page || width <= 0) return;
    wrapper.style.zoom = "1";
    const zoom = Math.min(1, (width - PAGE_PADDING * 2) / page.offsetWidth);
    wrapper.style.zoom = String(Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  }, [width, rendered]);
  return <div className="preview-word" ref={host} />;
}

function cellStyle(
  style: SheetCellStyle,
): CSSProperties & { "--cell-font-size"?: string | undefined } {
  const decoration = [style.underline ? "underline" : "", style.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  return {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: decoration || undefined,
    color: style.color,
    background: style.background,
    "--cell-font-size": style.fontSize
      ? `${Math.round(style.fontSize * (4 / 3) * 10) / 10}px`
      : undefined,
    textAlign: style.align,
    verticalAlign: style.verticalAlign,
    whiteSpace: style.wrap ? "pre-wrap" : undefined,
    overflowWrap: style.wrap ? "anywhere" : undefined,
    borderTop: style.borderTop,
    borderRight: style.borderRight,
    borderBottom: style.borderBottom,
    borderLeft: style.borderLeft,
  };
}

function SheetTable({ view }: { readonly view: SheetView }) {
  const stickyTop: number[] = [];
  let offset = HEADER_ROW_HEIGHT;
  for (const row of view.rows.slice(0, view.frozenRows)) {
    stickyTop.push(offset);
    offset += row.height ?? DEFAULT_ROW_HEIGHT;
  }
  return (
    <table className="preview-sheet-table">
      <colgroup>
        <col className="preview-sheet-index" />
        {view.columns.map((column) => (
          <col key={column.name} style={{ width: column.width }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th className="preview-sheet-corner" />
          {view.columns.map((column) => (
            <th key={column.name} scope="col">
              {column.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {view.rows.map((row, index) => {
          const top = stickyTop[index];
          const frozen = top === undefined ? undefined : { position: "sticky" as const, top };
          return (
            <tr
              key={row.number}
              className={top === undefined ? undefined : "is-frozen"}
              style={{ height: row.height }}
            >
              <th scope="row" style={frozen}>
                {row.number}
              </th>
              {row.cells.map((cell) => (
                <td
                  key={cell.column}
                  rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
                  colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
                  style={
                    frozen
                      ? {
                          ...cellStyle(cell.style),
                          ...frozen,
                          background: cell.style.background ?? "#fff",
                        }
                      : cellStyle(cell.style)
                  }
                >
                  {cell.text}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SheetDocument({
  data,
  message,
  onFailed,
}: {
  readonly data: ArrayBuffer;
  readonly message: Message;
  readonly onFailed: () => void;
}) {
  const [views, setViews] = useState<readonly SheetView[]>();
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let current = true;
    void (async () => {
      const { default: ExcelJS } = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(data.slice(0));
      const next = workbookViews(
        workbook.worksheets as unknown as Parameters<typeof workbookViews>[0],
      );
      if (current) setViews(next);
    })().catch(() => current && onFailed());
    return () => {
      current = false;
    };
  }, [data, onFailed]);
  if (!views) return null;
  const view = views[selected] ?? views[0];
  if (!view) return <p className="preview-notice">{message("preview.sheetEmpty")}</p>;
  return (
    <div className="preview-sheet">
      {views.length > 1 ? (
        <div className="preview-sheet-tabs" role="tablist" aria-label={message("preview.sheets")}>
          {views.map((item, index) => (
            <button
              type="button"
              role="tab"
              key={`${index}:${item.name}`}
              aria-selected={item === view}
              onClick={() => setSelected(index)}
            >
              {item.name}
            </button>
          ))}
        </div>
      ) : null}
      {view.truncated ? (
        <p className="preview-notice">{message("preview.sheetTruncated")}</p>
      ) : null}
      <div className="preview-sheet-scroll">
        <SheetTable view={view} />
      </div>
    </div>
  );
}

export function DocumentPreview({
  kind,
  data,
}: {
  readonly kind: DocumentKind;
  readonly data: ArrayBuffer;
}) {
  const { message } = useControlCenterIntl();
  const [failed, setFailed] = useState<ArrayBuffer>();
  const markFailed = useRef(() => {});
  markFailed.current = () => setFailed(data);
  const [onFailed] = useState(() => () => markFailed.current());
  if (failed === data) return <p className="preview-notice">{message("preview.renderFailed")}</p>;
  if (kind === "pdf") return <PdfDocument data={data} message={message} onFailed={onFailed} />;
  if (kind === "word") return <WordDocument data={data} onFailed={onFailed} />;
  return <SheetDocument data={data} message={message} onFailed={onFailed} />;
}
