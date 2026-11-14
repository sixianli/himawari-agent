export const TEXT_ADMISSION_CLASSIFICATIONS = [
  "public",
  "private",
  "sensitive",
  "restricted",
] as const;
export type TextAdmissionClassification = (typeof TEXT_ADMISSION_CLASSIFICATIONS)[number];

export const PLAIN_TEXT_MAXIMUM_CHARACTERS = 64 * 1024;

export interface AdmittedText {
  readonly content: string;
  readonly dataClassification: TextAdmissionClassification;
}

export function parseTextAdmission(
  body: Readonly<Record<string, unknown>>,
  maximumCharacters: number,
  accepts: (content: string) => boolean = () => true,
): AdmittedText | null {
  const { content, dataClassification } = body;
  if (
    Object.keys(body).some((key) => key !== "content" && key !== "dataClassification") ||
    typeof content !== "string" ||
    content.length === 0 ||
    content.length > maximumCharacters ||
    !accepts(content) ||
    !(TEXT_ADMISSION_CLASSIFICATIONS as readonly unknown[]).includes(dataClassification)
  )
    return null;
  return { content, dataClassification: dataClassification as TextAdmissionClassification };
}
