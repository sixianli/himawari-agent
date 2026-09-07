import type { RuntimeToolDescriptor, RuntimeToolInvocation } from "../ports/intelligence.js";

export const FILE_READ_REQUEST_CAPABILITY = "host.file.read";
export const FILE_READ_MAXIMUM_BYTES = 64 * 1024;
// Absolute end assertions also reject a final newline (unlike JavaScript's $).
const HOST_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*(?![\\s\\S])";
const PATH_PATTERN = "^/[^\\u0000-\\u001f\\u007f]*(?![\\s\\S])";
const HOST_EXPRESSION = new RegExp(HOST_PATTERN);
const PATH_EXPRESSION = new RegExp(PATH_PATTERN);

/** Product-owned intent contract. No filesystem access or permission is implied. */
export function fileReadRequestDescriptor(): RuntimeToolDescriptor {
  return {
    name: "request_file_read",
    capabilityRef: FILE_READ_REQUEST_CAPABILITY,
    capabilityHandleRef: null,
    description:
      "请求读取指定主机授权目录内的单个 UTF-8 普通文本文件，用于回答或总结。" +
      "不支持目录、二进制、PDF、Office 文件、递归或通配符。" +
      "提供明确的主机标识和绝对路径；不展开 ~、环境变量或 Shell 表达式。" +
      "maximumBytes 是整文件字节上限，最多 65536；超过上限应失败，不静默截断。" +
      "路径仅表示请求，读取和向模型披露均须服务端授权。" +
      "当前授权执行接入尚未完成，返回 FILE_READ_AUTHORIZATION_UNAVAILABLE 时表示未读取文件，不能声称已读取。",
    parameters: {
      type: "object",
      properties: {
        hostRef: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: HOST_PATTERN,
          description: "用户或产品上下文指定的主机标识；不得猜测或用另一个主机代替。",
        },
        path: {
          type: "string",
          minLength: 2,
          maxLength: 4096,
          pattern: PATH_PATTERN,
          description: "目标主机上的文件绝对路径，保留原始路径；目录授权和路径解析由服务端完成。",
        },
        maximumBytes: { type: "integer", minimum: 1, maximum: FILE_READ_MAXIMUM_BYTES },
      },
      required: ["hostRef", "path", "maximumBytes"],
      additionalProperties: false,
    },
  };
}

/** Validate again at the product boundary, even when Pi validated the JSON schema. */
export function validateFileReadRequest(invocation: RuntimeToolInvocation): boolean {
  const { hostRef, path, maximumBytes } = invocation.arguments;
  return (
    invocation.capabilityHandleRef === null &&
    invocation.capabilityRef === FILE_READ_REQUEST_CAPABILITY &&
    Object.keys(invocation.arguments).length === 3 &&
    typeof hostRef === "string" &&
    hostRef.length <= 128 &&
    HOST_EXPRESSION.test(hostRef) &&
    typeof path === "string" &&
    Array.from(path).length >= 2 &&
    Array.from(path).length <= 4096 &&
    PATH_EXPRESSION.test(path) &&
    typeof maximumBytes === "number" &&
    Number.isSafeInteger(maximumBytes) &&
    maximumBytes >= 1 &&
    maximumBytes <= FILE_READ_MAXIMUM_BYTES
  );
}
