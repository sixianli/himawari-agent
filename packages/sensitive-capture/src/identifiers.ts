const RESTRICTED_IDENTIFIER =
  /(?<![0-9])(?:[1-9][0-9]{5}(?:19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]|[0-9]{16,19})(?![0-9])/u;

export function containsRestrictedIdentifier(text: string): boolean {
  return RESTRICTED_IDENTIFIER.test(text.replace(/[\s-]/gu, ""));
}

const SENSITIVE_MENTION =
  /密码|口令|password|passwd|token|secret|api[ _-]?key|身份证|银行卡|卡号|ghp_|sk-|\d{15,19}/i;

export function mentionsSensitiveMaterial(text: string): boolean {
  return SENSITIVE_MENTION.test(text);
}

const SENSITIVE_QUERY_PARAMETER = /token|key|secret|password|signature|credential/i;
const SENSITIVE_FIELD_NAME = /authorization|cookie|token|api.?key|secret|password|credential/i;

export function isSensitiveQueryParameter(name: string): boolean {
  return SENSITIVE_QUERY_PARAMETER.test(name);
}

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAME.test(name);
}
