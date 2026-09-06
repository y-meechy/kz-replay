/** Resolve a published generation once, so geometry and lighting cannot cross revisions. */
export const resolveMapAssets = async (mapUrl, fetcher = fetch) => {
  const base = new URL(
    mapUrl,
    globalThis.location?.href ?? "http://localhost/",
  );
  if (!base.pathname.endsWith(".glb"))
    return { geometryUrl: mapUrl, legacy: true };
  // An immutable URL already pins a generation; its sibling manifest records the bundle.
  const immutable = base.pathname.includes(".assets/");
  const manifestUrl = new URL(base);
  manifestUrl.pathname = immutable
    ? base.pathname.replace(/[^/]+$/, "manifest.json")
    : base.pathname.replace(/\.glb$/, ".assets.json");
  const response = await fetcher(manifestUrl.href, { cache: "no-cache" });
  if (
    response.status === 404 ||
    (response.headers.get("content-type") ?? "").includes("html")
  ) {
    if (immutable) throw new Error("Missing immutable map manifest");
    return { geometryUrl: mapUrl, legacy: true };
  }
  if (!response.ok) throw new Error(`Map manifest returned ${response.status}`);
  const manifest = await response.json();
  if (manifest.schemaVersion !== 1)
    throw new Error("Unsupported map asset schema");
  const revision =
    manifest.revisions?.[manifest.activeRevision] ??
    (immutable ? manifest : null);
  if (!revision?.files?.geometry)
    throw new Error("Incomplete map asset manifest");
  const assetBase = new URL(manifestUrl);
  if (immutable)
    assetBase.pathname = base.pathname
      .split(".assets/")[0]
      .replace(/[^/]+$/, "");
  const revisionId = manifest.activeRevision ?? manifest.revision;
  if (!/^[A-Za-z0-9_-]+$/.test(revisionId ?? ""))
    throw new Error("Invalid map revision");
  const prefix = `${base.pathname.split(".assets/")[0].replace(/\.glb$/, "")}.assets/${revisionId}/`;
  const files = {};
  for (const [name, entry] of Object.entries(revision.files)) {
    if (entry === null) {
      files[name] = null;
      continue;
    }
    if (
      typeof entry?.url !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
    ) {
      throw new Error(`Invalid ${name} asset descriptor`);
    }
    const resolved = new URL(entry.url, assetBase);
    if (
      resolved.origin !== base.origin ||
      !resolved.pathname.startsWith(prefix)
    ) {
      throw new Error(`Asset ${name} escapes its immutable bundle`);
    }
    files[name] = { ...entry, url: resolved.href };
  }
  return {
    geometryUrl: files.geometry.url,
    files,
    manifest,
    revision,
    legacy: false,
  };
};

/** Legacy names retain cache keys; dropping the query used to pair fresh GLBs with stale atlases. */
export const legacySidecarUrl = (mapUrl, suffix) => {
  const url = new URL(mapUrl, globalThis.location?.href ?? "http://localhost/");
  if (!url.pathname.endsWith(".glb")) return null;
  url.pathname = url.pathname.replace(/\.glb$/, suffix);
  return url.href;
};
