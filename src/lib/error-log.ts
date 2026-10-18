const databaseFields = ["severity", "table", "column", "constraint", "routine"];

// A getter that throws must not stop an error from being logged.
function stringField(error: unknown, key: string): string | undefined {
  try {
    const value = (error as Record<string, unknown> | null | undefined)?.[key];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

// The first stack line repeats the message, and a multi-line message runs on
// until the first frame.
function stackFrames(stack: string) {
  const lines = stack.split("\n");
  const start = Math.max(
    1,
    lines.findIndex((line) => /^\s*at\s/.test(line)),
  );
  return lines
    .slice(start, start + 8)
    .map((line) => line.trim())
    .join("\n")
    .slice(0, 1500);
}

// Safe to log: identifiers and frames only. A database message can quote the
// offending value, so it is kept only for errors without a code.
export function errorSummary(error: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    name:
      stringField(error, "name") ?? (error === null ? "null" : typeof error),
  };
  const code = stringField(error, "code");
  if (code) summary.code = code;
  for (const key of databaseFields) {
    const value = stringField(error, key);
    if (value) summary[key] = value;
  }
  const message = stringField(error, "message");
  if (message && !code) summary.message = message.slice(0, 300);
  const stack = stringField(error, "stack");
  if (stack) {
    const trace = stackFrames(stack);
    if (trace) summary.stack = trace;
  }
  return summary;
}
