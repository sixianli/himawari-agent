import { redactForEgress } from "@himawari-agent/sensitive-capture";

export function maskForExport(text: string): string {
  return redactForEgress(text).text;
}
