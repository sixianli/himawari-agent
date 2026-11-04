declare const __PDFJS_ASSET_DIRECTORY__: string | undefined;

const directory =
  typeof __PDFJS_ASSET_DIRECTORY__ === "string" ? __PDFJS_ASSET_DIRECTORY__ : "assets/pdfjs";

export const pdfDocumentFontOptions = {
  cMapUrl: `/${directory}/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `/${directory}/standard_fonts/`,
  wasmUrl: `/${directory}/wasm/`,
} as const;
