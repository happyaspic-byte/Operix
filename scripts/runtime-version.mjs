export function assertSupportedNodeVersion(version = process.versions.node) {
  if (!/^24\.\d+\.\d+$/.test(version))
    throw new Error(
      "Operix requires Node.js 24. Use the pinned project runtime.",
    );
}
