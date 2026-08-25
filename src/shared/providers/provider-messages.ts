// User-facing mapping for provider failures.
//
// Shared by both the video caption pipeline and the free-text (comment/selection)
// pipeline so every failure surfaces the same sanitized Chinese message. The
// mapped text never includes the API key or a request/response body.

import type { ProviderFailureReason } from "./provider-types";

export function userFacingProviderMessage(reason: ProviderFailureReason): string {
  switch (reason) {
    case "auth":
      return "服务密钥无效或权限不足，请到偏好设置检查。";
    case "rate-limit":
      return "翻译服务当前较忙，请稍后再试。";
    case "timeout":
      return "翻译请求超时，请重试。";
    case "network":
      return "暂时无法连接翻译服务，请检查网络后再试。";
    case "model":
      return "当前模型不可用，请到偏好设置更换模型。";
    case "bad-response":
      return "翻译服务暂时异常，请稍后再试。";
  }
}
