import { guardSpreadsheetArchive } from "./sheets";
import { createConnection } from "node:net";
export type ScanResult = {
  status: "clean" | "infected" | "error";
  error?: string;
};
export async function scanBytes(bytes: Buffer): Promise<ScanResult> {
  if (bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
    try {
      guardSpreadsheetArchive(bytes);
    } catch {
      return { status: "error", error: "archive_not_scannable" };
    }
  }
  const mode = process.env.FILE_SCAN_MODE || "clamav";
  if (mode === "test") {
    if (
      !(
        process.env.CI === "true" ||
        process.env.OPERIX_EMBEDDED === "1" ||
        process.env.OPERIX_CONTAINER_TEST === "1"
      ) ||
      (process.env.APP_URL || "").startsWith("https://")
    )
      return { status: "error", error: "test_mode_forbidden" };
    return bytes.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"))
      ? { status: "infected" }
      : { status: "clean" };
  }
  if (mode !== "clamav")
    return { status: "error", error: "scanner_not_configured" };
  return new Promise((resolve) => {
    const socket = createConnection({
      host: process.env.CLAMD_HOST || "scanner",
      port: Number(process.env.CLAMD_PORT) || 3310,
    });
    let result = "",
      finished = false;
    const deadline = setTimeout(
      () => done({ status: "error", error: "scanner_deadline" }),
      15000,
    );
    function done(value: ScanResult) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(value);
    }
    socket.setTimeout(15000, () =>
      done({ status: "error", error: "scanner_timeout" }),
    );
    socket.on("error", () =>
      done({ status: "error", error: "scanner_unavailable" }),
    );
    socket.on("end", () => {
      if (!finished) done({ status: "error", error: "scanner_closed" });
    });
    socket.on("data", (chunk) => {
      result += chunk.toString();
      if (result.length > 4096)
        return done({ status: "error", error: "invalid_scanner_response" });
      if (result.includes("\0") || result.includes("\n"))
        done(
          result.includes(" FOUND")
            ? { status: "infected" }
            : result.includes(": OK")
              ? { status: "clean" }
              : { status: "error", error: "scan_failed" },
        );
    });
    socket.on("connect", async () => {
      try {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          const chunk = bytes.subarray(offset, offset + 65536),
            length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length);
          socket.write(length);
          if (!socket.write(chunk))
            await new Promise<void>((ok, no) => {
              const clean = () => {
                socket.off("drain", drain);
                socket.off("error", error);
                socket.off("close", closed);
              };
              const drain = () => {
                  clean();
                  ok();
                },
                error = (e: Error) => {
                  clean();
                  no(e);
                },
                closed = () => error(new Error("closed"));
              socket.once("drain", drain);
              socket.once("error", error);
              socket.once("close", closed);
            });
        }
        socket.write(Buffer.alloc(4));
      } catch {
        done({ status: "error", error: "scanner_stream_failed" });
      }
    });
  });
}
