// Small SSE reader shared by the OpenAI-compatible and Anthropic adapters.

export interface ServerSentEvent {
  event?: string;
  data: string;
}

export async function readServerSentEvents(
  response: Response,
  onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Streaming response has no readable body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length > 0) {
      onEvent({
        ...(eventName ? { event: eventName } : {}),
        data: dataLines.join("\n"),
      });
    }
    eventName = undefined;
    dataLines = [];
  };

  const consumeLines = (flush: boolean): void => {
    if (flush) {
      if (buffer.length > 0) {
        buffer += "\n";
      }
    }

    let lineEnd = buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd).replace(/\r$/u, "");
      buffer = buffer.slice(lineEnd + 1);

      if (line.length === 0) {
        dispatch();
      } else if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        const value = line.slice("data:".length);
        dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
      }
      lineEnd = buffer.indexOf("\n");
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        consumeLines(true);
        dispatch();
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      consumeLines(false);
    }
  } finally {
    reader.releaseLock();
  }
}
