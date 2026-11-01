declare module "*.png" {
  const source: string;
  export default source;
}

declare module "*?url" {
  const source: string;
  export default source;
}

declare const __HIMAWARI_BUILD__: { readonly revision: string; readonly date: string } | null;
