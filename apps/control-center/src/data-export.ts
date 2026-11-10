export const DATA_EXPORT_URL = "/api/data-export/v1/archive";

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
