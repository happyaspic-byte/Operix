const databaseFields = ["severity", "table", "column", "constraint", "routine"];
// A message is logged only when it is one of the fixed strings pg and pg-pool
// throw for connection and timeout failures. Any other message can quote data:
// V8 builds TypeError and RangeError text from templates that interpolate
// runtime values, and parsers and libraries echo their input. Every other error
// is located by its name, code and frames.
const fixedMessages = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
  "Query read timeout",
  "timeout expired",
]);

// A getter that throws must not stop an error from being logged.
function stringField(error: unknown, key: string): string | undefined {
  try {
    const value = (error as Record<string, unknown> | null | undefined)?.[key];
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

// The header repeats the message, one line per line of it. Counting those lines
// keeps a quoted value out of the frames even when one of its lines starts with
// "at ". The header's name is not compared: it may differ from the error's
// current name.
function headerLines(stack: string, message: string | undefined) {
  if (message === undefined) return undefined;
  const at = stack.indexOf(message);
  if (at < 0 || stack.slice(0, at).includes("\n")) return undefined;
  return message.split("\n").length;
}

function stackFrames(stack: string, message: string | undefined) {
  const lines = stack.split("\n");
  let start = headerLines(stack, message);
  if (start === undefined) {
    // A multi-line message the stack does not carry may have quoted a line
    // that starts with "at ", which the fallback below would take for a frame.
    if (message?.includes("\n")) return "";
    // Without the message in the header, the first "at " line opens the frames.
    start = Math.max(
      1,
      lines.findIndex((line) => /^\s*at\s/.test(line)),
    );
  }
  return lines
    .slice(start, start + 8)
    .map((line) => line.trim())
    .join("\n")
    .slice(0, 1500);
}

// Safe to log: identifiers and frames only. A database message can quote the
// offending value, so an error with a code never logs its message.
export function errorSummary(error: unknown): Record<string, unknown> {
  const name =
    stringField(error, "name") ?? (error === null ? "null" : typeof error);
  const summary: Record<string, unknown> = { name };
  const code = stringField(error, "code");
  if (code) summary.code = code;
  for (const key of databaseFields) {
    const value = stringField(error, key);
    if (value) summary[key] = value;
  }
  const message = stringField(error, "message");
  if (message && !code && fixedMessages.has(message)) summary.message = message;
  const stack = stringField(error, "stack");
  if (stack) {
    const trace = stackFrames(stack, message);
    if (trace) summary.stack = trace;
  }
  return summary;
}
