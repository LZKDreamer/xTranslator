// A successful HTTP response can still contain an incomplete or malformed
// model answer. Keep that recovery policy shared by every translation flow.
export const MODEL_RESPONSE_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 800,
} as const;

export function waitForModelResponseRetry(completedAttempts: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, MODEL_RESPONSE_RETRY.baseDelayMs * 2 ** (completedAttempts - 1));
  });
}
