import { describe, expect, it } from "vitest";
import { MODEL_RESPONSE_RETRY } from "../src/shared/translation/model-response-retry";

describe("model response retry policy", () => {
  it("uses three attempts with exponential backoff", () => {
    expect(MODEL_RESPONSE_RETRY).toEqual({ maxAttempts: 3, baseDelayMs: 800 });
  });
});
