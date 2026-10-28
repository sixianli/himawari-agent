import type { BrowserThreadFileContent } from "./browser-thread-files.js";

export const PREVIEW_STORAGE_SCRIPT =
  '<script>(()=>{for(const name of ["localStorage","sessionStorage"]){try{void window[name];continue}catch{}' +
  "const items=new Map();" +
  "const storage={get length(){return items.size}," +
  "key:(index)=>[...items.keys()][index]??null," +
  "getItem:(key)=>items.has(String(key))?items.get(String(key)):null," +
  "setItem:(key,value)=>{items.set(String(key),String(value))}," +
  "removeItem:(key)=>{items.delete(String(key))}," +
  "clear:()=>{items.clear()}};" +
  "Object.defineProperty(window,name,{configurable:true,enumerable:true,get:()=>storage})}})();</script>";

const LEADING_DOCTYPE = /^\s*<!doctype[^>]*>/i;

export function withPreviewStorage(content: BrowserThreadFileContent): BrowserThreadFileContent {
  if (content.mediaType !== "text/html") {
    return content;
  }
  const html = new TextDecoder().decode(content.bytes);
  const doctype = LEADING_DOCTYPE.exec(html)?.[0] ?? "";
  return {
    ...content,
    bytes: new TextEncoder().encode(
      `${doctype}${PREVIEW_STORAGE_SCRIPT}${html.slice(doctype.length)}`,
    ),
  };
}
