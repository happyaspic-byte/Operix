const databaseFields = ["severity", "table", "column", "constraint", "routine"];
// A message is logged only where it cannot quote request data: V8 words
// programmer errors from code identifiers, and pg and pg-pool throw their
// connectivity messages as fixed strings. Parsers and libraries echo their input
// (a CSV reader quotes the rows it choked on), so for any other error the name,
// code and frames locate the fault.
const programmerErrors = new Set(["TypeError", "RangeError", "ReferenceError"]);
const connectivityMessages = new Set([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
  "Connection terminated unexpectedly",
  "Connection terminated",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
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
  // Without the message in the header, the first "at " line opens the frames.
  const start =
    headerLines(stack, message) ??
    Math.max(
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
  if (
    message &&
    !code &&
    (programmerErrors.has(name) || connectivityMessages.has(message))
  )
    summary.message = message.slice(0, 300);
  const stack = stringField(error, "stack");
  if (stack) {
    const trace = stackFrames(stack, message);
    if (trace) summary.stack = trace;
  }
  return summary;
}
