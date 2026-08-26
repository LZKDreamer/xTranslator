// User-facing mapping for provider failures.
//
// Shared by both the video caption pipeline and the free-text (comment/selection)
// pipeline so every failure surfaces the same sanitized Chinese message. The
// mapped text never includes the API key or a request/response body.

import type { ProviderFailureReason } from "./provider-types";
import { t } from "../i18n";

export function userFacingProviderMessage(reason: ProviderFailureReason): string {
  switch (reason) {
    case "auth":
      return t("provider.auth");
    case "rate-limit":
      return t("provider.rateLimit");
    case "timeout":
      return t("provider.timeout");
    case "network":
      return t("provider.network");
    case "model":
      return t("provider.model");
    case "bad-response":
      return t("provider.badResponse");
  }
}
