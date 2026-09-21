import { pathToFileURL } from "node:url";
export async function verifyDeployment(
  address,
  revision,
  { fetcher = fetch, allowHttp = false } = {},
) {
  const url = new URL(address);
  if (
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Supply the HTTPS service origin without credentials, path or query.",
    );
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Supply the expected full source commit SHA.");
  const options = {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { "Cache-Control": "no-cache" },
  };
  const health = await fetcher(new URL("/api/health", url), options);
  if (!health.ok) throw new Error("Service health check failed.");
  const body = await health.json();
  if (body.status !== "ok" || body.revision !== revision)
    throw new Error("Service health or deployed revision does not match.");
  const login = await fetcher(new URL("/login", url), {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  if (
    !login.ok ||
    !login.headers.get("content-type")?.includes("text/html") ||
    !(await login.text()).includes("로그인")
  )
    throw new Error("Login page availability check failed.");
  return {
    revision,
    health: "ok",
    login: "ok",
    checked_at: new Date().toISOString(),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(
        await verifyDeployment(process.argv[2], process.argv[3], {
          allowHttp: process.argv.includes("--allow-http"),
        }),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
