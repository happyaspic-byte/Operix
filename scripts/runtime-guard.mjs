const local =
  process.env.OPERIX_EMBEDDED === "1" ||
  process.env.OPERIX_CONTAINER_TEST === "1" ||
  process.env.CI === "true";
if (!local) {
  if (!(process.env.APP_URL || "").startsWith("https://"))
    throw new Error(
      "Production APP_URL must use HTTPS. Configure the TLS reverse proxy first.",
    );
  if (
    !process.env.SECURITY_LOG_KEY ||
    process.env.SECURITY_LOG_KEY.length < 32 ||
    process.env.SECURITY_LOG_KEY === process.env.SESSION_SECRET
  )
    throw new Error(
      "Production requires an independent SECURITY_LOG_KEY of at least 32 characters.",
    );
  if (process.env.FILE_SCAN_MODE && process.env.FILE_SCAN_MODE !== "clamav")
    throw new Error("Production requires ClamAV scanning.");
}
