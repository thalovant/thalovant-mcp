#!/usr/bin/env node
// Says whether GHCR already serves ghcr.io/thalovant/thalovant-mcp:<version>,
// and which commit it was built from.
//
//   node scripts/published-image.mjs <version> <expected-commit>
//
// Prints `absent` when the tag does not exist, `present <digest>` when it
// exists and its linux/amd64 config says it was built from <expected-commit>,
// and exits 1 when the tag exists but was built from anything else. A
// published tag is immutable here: the release workflow never pushes over it,
// so a re-run after a partial release cannot move a digest somebody pinned.
const [version, expected] = process.argv.slice(2);
if (!version || !/^[0-9a-f]{40}$/.test(expected ?? "")) {
  console.error("usage: published-image.mjs <version> <40-hex commit>");
  process.exit(2);
}

const repository = "thalovant/thalovant-mcp";
const registry = `https://ghcr.io/v2/${repository}`;
const accept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function get(url, headers) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.status < 500 || attempt === 3) return response;
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

const tokenResponse = await get(`https://ghcr.io/token?scope=repository:${repository}:pull`, {});
if (!tokenResponse.ok) throw new Error(`GHCR token: HTTP ${tokenResponse.status}`);
const { token } = await tokenResponse.json();
const auth = { Authorization: `Bearer ${token}` };

const top = await get(`${registry}/manifests/${version}`, { ...auth, Accept: accept });
if (top.status === 404) {
  console.log("absent");
  process.exit(0);
}
if (!top.ok) throw new Error(`GHCR manifest ${version}: HTTP ${top.status}`);
const digest = top.headers.get("docker-content-digest");
let manifest = await top.json();

if (Array.isArray(manifest.manifests)) {
  const image = manifest.manifests.find(
    (entry) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64",
  );
  if (!image) throw new Error(`${version} has no linux/amd64 image`);
  const child = await get(`${registry}/manifests/${image.digest}`, { ...auth, Accept: accept });
  if (!child.ok) throw new Error(`GHCR manifest ${image.digest}: HTTP ${child.status}`);
  manifest = await child.json();
}

const blob = await get(`${registry}/blobs/${manifest.config.digest}`, auth);
if (!blob.ok) throw new Error(`GHCR config ${manifest.config.digest}: HTTP ${blob.status}`);
const labels = (await blob.json()).config?.Labels ?? {};
const revision = labels["org.opencontainers.image.revision"];
const labelled = labels["org.opencontainers.image.version"];
if (revision !== expected || labelled !== version) {
  console.error(
    `ghcr.io/${repository}:${version} already exists but was built from ${revision} (version ${labelled}), ` +
      `not ${expected}. Published tags are never overwritten; publish a new version instead.`,
  );
  process.exit(1);
}
console.log(`present ${digest}`);
