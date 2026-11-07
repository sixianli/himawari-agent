import { WebProviderError, type WebProviderFailureCode } from "@himawari-agent/application";

export function webProviderFailure(error: unknown): WebProviderError {
  if (error instanceof WebProviderError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  const code: WebProviderFailureCode = /RATE_LIMITED$/.test(message)
    ? "RATE_LIMITED"
    : /TIMEOUT$/.test(message) || name === "TimeoutError"
      ? "TIMEOUT"
      : /UNREACHABLE$/.test(message)
        ? "PAGE_UNREACHABLE"
        : /RESPONSE_LIMIT$|TOO_LARGE$/.test(message)
          ? "CONTENT_TOO_LARGE"
          : /INPUT_UNSUPPORTED$/.test(message)
            ? "INPUT_UNSUPPORTED"
            : /INPUT_INVALID$|INPUT_LIMIT$/.test(message)
              ? "INPUT_INVALID"
              : "UNAVAILABLE";
  return new WebProviderError(code, message || code);
}

type FailureReport = { readonly code: string; readonly message: string };

const searchReports: Readonly<Record<WebProviderFailureCode, FailureReport>> = {
  RATE_LIMITED: {
    code: "WEB_SEARCH_RATE_LIMITED",
    message: "公开搜索服务正在限流，请等几秒再搜一次，不要连续重试。",
  },
  TIMEOUT: {
    code: "WEB_SEARCH_TIMEOUT",
    message: "搜索超时，没有拿到结果。可以重试一次；仍然超时就把查询改短、改具体。",
  },
  UNAVAILABLE: {
    code: "WEB_SEARCH_UNAVAILABLE",
    message: "搜索服务暂时不可用，马上重试大概率仍会失败，请稍后再试。",
  },
  INPUT_UNSUPPORTED: {
    code: "WEB_SEARCH_INPUT_UNSUPPORTED",
    message: "搜索服务不接受这个查询（例如太长）。缩短查询后再搜。",
  },
  INPUT_INVALID: {
    code: "WEB_SEARCH_INPUT_INVALID",
    message: "查询不符合要求：不能为空、不能超过 4096 字节、不能包含凭据。改好后再搜。",
  },
  PAGE_UNREACHABLE: {
    code: "WEB_SEARCH_UNAVAILABLE",
    message: "搜索服务暂时不可用，马上重试大概率仍会失败，请稍后再试。",
  },
  CONTENT_TOO_LARGE: {
    code: "WEB_SEARCH_TOO_LARGE",
    message: "搜索结果超过单次可接收的大小。把结果条数 limit 调小后再搜。",
  },
};

const fetchReports: Readonly<Record<WebProviderFailureCode, FailureReport>> = {
  RATE_LIMITED: {
    code: "WEB_FETCH_RATE_LIMITED",
    message: "读网页服务正在限流，请等几秒再读，不要连续重试。",
  },
  TIMEOUT: {
    code: "WEB_FETCH_TIMEOUT",
    message: "读取网页超时。可以重试一次；仍然超时就改读搜索结果里的其他来源网址。",
  },
  UNAVAILABLE: {
    code: "WEB_FETCH_UNAVAILABLE",
    message: "读网页服务暂时不可用，马上重试大概率仍会失败，请稍后再试。",
  },
  INPUT_UNSUPPORTED: {
    code: "WEB_FETCH_INPUT_UNSUPPORTED",
    message: "读网页服务不支持这个网址。请换其他来源网址。",
  },
  INPUT_INVALID: {
    code: "WEB_FETCH_INPUT_INVALID",
    message:
      "网址或参数不符合要求：只能读公开的 http(s) 网址，不能是内网地址，不能带账号密码或凭据；offset 必须是不小于 0 的整数。",
  },
  PAGE_UNREACHABLE: {
    code: "WEB_FETCH_UNREACHABLE",
    message:
      "这个网址打不开或拒绝被读取（例如页面不存在、需要登录或禁止抓取）。不要重试同一网址，请换其他来源网址。",
  },
  CONTENT_TOO_LARGE: {
    code: "WEB_FETCH_TOO_LARGE",
    message: "网页内容超过可读取的上限。请换一个更具体的页面网址。",
  },
};

function report(reports: Readonly<Record<WebProviderFailureCode, FailureReport>>, error: unknown) {
  const { code, message } = reports[webProviderFailure(error).code];
  return { code, output: JSON.stringify({ error: code, message }) };
}

export function publicSearchFailure(error: unknown): {
  readonly code: string;
  readonly output: string;
} {
  return report(searchReports, error);
}

export function publicFetchFailure(error: unknown): {
  readonly code: string;
  readonly output: string;
} {
  return report(fetchReports, error);
}
