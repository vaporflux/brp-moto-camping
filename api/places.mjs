/* Google Places lookup, server-side so the API key stays secret.
 *
 * Smoke test after deploying:
 *   https://<your-app>.vercel.app/api/places?lat=35.59&lon=-82.55&type=lodging
 * A 503 means the key is not set; a 200 with a places array means it is working.
 *
 * This is the ONLY server-side code in the project, and it exists for one reason: a Vercel
 * environment variable is only a secret if the code reading it runs on Vercel. A static
 * page's JavaScript cannot read one, and inlining it at build time puts it in the page
 * source for anyone to lift. So the key lives here and the browser never sees it.
 *
 * Set GOOGLE_PLACES_API_KEY in the Vercel project settings (Settings -> Environment
 * Variables). Restrict the key to the Places API in the Google Cloud console as well --
 * defence in depth, since a leaked unrestricted key is billable against everything.
 *
 * Everything else in this app works offline. This does not, by definition, and the page
 * treats it as an optional supplement rather than a dependency.
 *
 * FILE EXTENSION IS LOAD-BEARING. This is .mjs, not .js, because Vercel's Node runtime
 * treats a bare .js file as CommonJS unless package.json declares "type": "module" -- and
 * `export default` then fails to parse, so the function never deploys and the route 404s.
 * The alternative fix is adding a package.json, but this repo deliberately has no build
 * step and introducing one risks changing how Vercel treats the whole project. Renaming
 * the file is the contained fix.
 */

const ALLOWED_TYPES = new Set(['campground', 'rv_park', 'lodging', 'gas_station']);
const MAX_RADIUS_M = 40000;      // ~25 mi, the same corridor the OSM pull uses

export default async function handler(req, res) {
  // Either name works, so one variable covers both this and api/route.js. They read the
  // same pair deliberately: setting only one of two differently-named vars half-configured
  // the app and failed in a way that looked like a Google problem.
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: 'Google Places is not configured for this deployment.',
      hint: 'Set GOOGLE_MAPS_API_KEY (or GOOGLE_PLACES_API_KEY) in the Vercel project '
          + 'environment variables, with the Places API (New) enabled on that key.'
    });
  }

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusM = Math.min(Number(req.query.radius_m) || 16000, MAX_RADIUS_M);
  const type = String(req.query.type || 'lodging');

  if (!Number.isFinite(lat) || !Number.isFinite(lon)
      || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'lat and lon are required and must be valid.' });
  }
  // Only the categories this planner actually uses. Without this the endpoint is an open
  // proxy onto a billable account.
  if (!ALLOWED_TYPES.has(type)) {
    return res.status(400).json({
      error: `type must be one of: ${[...ALLOWED_TYPES].join(', ')}`
    });
  }

  const url = 'https://places.googleapis.com/v1/places:searchNearby';
  const body = {
    includedTypes: [type],
    maxResultCount: 20,
    locationRestriction: {
      circle: { center: { latitude: lat, longitude: lon }, radius: radiusM }
    }
  };
  // Field mask is billing-relevant: asking for fewer fields costs less per call.
  const fields = [
    'places.id', 'places.displayName', 'places.location', 'places.formattedAddress',
    'places.rating', 'places.userRatingCount', 'places.primaryType',
    'places.nationalPhoneNumber', 'places.websiteUri', 'places.currentOpeningHours.openNow'
  ].join(',');

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fields
      },
      body: JSON.stringify(body)
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(upstream.status).json({
        error: 'Google Places rejected the request.',
        detail: detail.slice(0, 400)
      });
    }
    const data = await upstream.json();
    const places = (data.places || []).map(p => ({
      id: p.id,
      name: p.displayName?.text || '(unnamed)',
      lat: p.location?.latitude,
      lon: p.location?.longitude,
      address: p.formattedAddress,
      rating: p.rating,
      ratings: p.userRatingCount,
      type: p.primaryType,
      phone: p.nationalPhoneNumber,
      url: p.websiteUri,
      open_now: p.currentOpeningHours?.openNow,
      source: 'google'
    })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

    // Short cache: Google's terms restrict retaining Places content, and a trip planner
    // does not need fresher than this within a single planning session.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ places, source: 'google', radius_m: radiusM });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Google Places.', detail: String(e) });
  }
}
