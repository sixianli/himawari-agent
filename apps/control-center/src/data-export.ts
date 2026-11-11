export const DATA_EXPORT_URL = "/api/data-export/v1/archive";
export const CHAT_EXPORT_URL = "/api/data-export/v1/chats";

export interface DataExportResult {
  readonly blob: Blob;
  readonly fileName: string;
  readonly memories: number;
  readonly withheld: number;
}

export async function requestDataExport(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<DataExportResult> {
  const response = await fetcher(DATA_EXPORT_URL, { credentials: "same-origin" });
  if (!response.ok) throw new Error("DATA_EXPORT_FAILED");
  const count = (name: string) => {
    const value = Number(response.headers.get(name));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName =
    /filename="([A-Za-z0-9._-]{1,80})"/.exec(disposition)?.[1] ?? "himawari-export.zip";
  return {
    blob: await response.blob(),
    fileName,
    memories: count("x-himawari-export-memories"),
    withheld: count("x-himawari-export-withheld"),
  };
}

export interface ChatExportResult {
  readonly blob: Blob;
  readonly fileName: string;
  readonly threads: number;
  readonly messages: number;
  readonly withheld: number;
}

export async function requestChatExport(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<ChatExportResult> {
  const response = await fetcher(CHAT_EXPORT_URL, { credentials: "same-origin" });
  if (response.status === 413) throw new Error("CHAT_EXPORT_TOO_LARGE");
  if (!response.ok) throw new Error("CHAT_EXPORT_FAILED");
  const count = (name: string) => {
    const header = response.headers.get(name);
    const value = header === null ? Number.NaN : Number(header);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("CHAT_EXPORT_FAILED");
    return value;
  };
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName =
    /filename="([A-Za-z0-9._-]{1,80})"/.exec(disposition)?.[1] ?? "himawari-chats.zip";
  return {
    blob: await response.blob(),
    fileName,
    threads: count("x-himawari-export-threads"),
    messages: count("x-himawari-export-messages"),
    withheld: count("x-himawari-export-withheld"),
  };
}
