// Steam Workshop preview images.
//
// The CS2KZ API knows every map's workshop id but stores no picture of it. Steam
// does: ISteamRemoteStorage/GetPublishedFileDetails returns a `preview_url` for any
// published item, needs no API key, and takes up to a few hundred ids per call.
//
// It is a POST with form-encoded array indices, and it sends no CORS headers, so it
// can only be called from the server. That is fine: the nightly refresh calls it
// once and writes the urls into maps.json, and the browser then loads the images
// straight from Steam's CDN. An <img> needs no CORS.

const STEAM_DETAILS_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";

// Steam accepts large batches, but a failed batch loses every id in it, so keep
// them small enough that one bad response is cheap to redo.
const BATCH_SIZE = 50;

const fetchBatch = async (workshopIds) => {
  const body = new URLSearchParams({ itemcount: String(workshopIds.length) });
  workshopIds.forEach((id, index) => {
    body.set(`publishedfileids[${index}]`, String(id));
  });

  const response = await fetch(STEAM_DETAILS_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Steam returned ${response.status}`);
  }
  const data = await response.json();
  return data?.response?.publishedfiledetails ?? [];
};

/**
 * Preview image url per workshop id.
 *
 * Ids Steam does not know about are simply missing from the result, so the caller
 * decides what a map with no picture looks like rather than getting a broken url.
 *
 * @returns Map<string workshopId, { image, title, updatedAt }>
 */
export const fetchWorkshopPreviews = async (workshopIds, { log } = {}) => {
  const unique = [...new Set(workshopIds.map(String))];
  const found = new Map();

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    let details;
    try {
      details = await fetchBatch(batch);
    } catch (error) {
      // A missing picture is cosmetic. Losing the whole refresh over one is not.
      log?.(
        `workshop previews ${i}-${i + batch.length} failed: ${error.message}`,
      );
      continue;
    }

    for (const item of details) {
      if (item?.result !== 1 || !item.preview_url) continue;
      found.set(String(item.publishedfileid), {
        image: item.preview_url,
        title: item.title ?? null,
        updatedAt: item.time_updated
          ? new Date(item.time_updated * 1000).toISOString()
          : null,
      });
    }
  }

  return found;
};
