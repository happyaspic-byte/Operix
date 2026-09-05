import { readdir, rename, rmdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
// One-time upgrade from the original volume mounted at /app/storage.
const root = resolve(process.env.UPLOAD_DIR || "storage/uploads"),
  legacy = join(root, "uploads");
try {
  if ((await stat(legacy)).isDirectory()) {
    const names = await readdir(legacy);
    if (names.some((n) => !/^[-a-f0-9]{36}$/.test(n)))
      throw new Error(
        "Unexpected legacy upload entries: inspect before migration",
      );
    for (const name of names) {
      try {
        await stat(join(root, name));
        throw new Error("Legacy upload collision");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await rename(join(legacy, name), join(root, name));
    }
    await rmdir(legacy);
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
