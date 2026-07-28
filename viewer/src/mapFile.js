// Has this map been converted, and how big is the file?
//
// A HEAD request, with one wrinkle that is easy to miss: a dev server answers a path
// it does not recognise with index.html and a 200, because that is how a single page
// app is served. An unconverted map then looks like a hit, and the failure only
// surfaces later as the GLTF loader choking on "<!doctype". The deployed server does
// return a 404, so this only ever bites in development — which is exactly where the
// message "not converted yet" needs to be right.
//
// Geometry is a .glb: model/gltf-binary, or a plain stream of bytes on a host that
// does not know the type. HTML never means a map.

export const findMapFile = async (url) => {
  const head = await fetch(url, { method: "HEAD" }).catch(() => null);
  if (!head?.ok) return null;
  if ((head.headers.get("content-type") ?? "").includes("html")) return null;
  return {
    url,
    megabytes: Number(head.headers.get("content-length") ?? 0) / 1e6,
  };
};
