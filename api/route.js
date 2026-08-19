/* Road routing for the legs that are not on the Parkway.
 *
 * The Parkway itself needs no router: between junctions it has no alternatives, so the
 * centerline sliced between two mileposts IS the route. Everything else does -- the ride
 * from the rider's house to the access point, the ride from the exit point to wherever
 * they finish, and the hop off the Parkway to a campsite or hotel that is not on it.
 *
 * Those legs used to be drawn as a straight dashed line and exported with no geometry at
 * all, which left the Garmin free to invent its own way there. Real geometry fixes both:
 * the map shows the actual roads, and the exporter can hang shaping points along them.
 *
 * Google Directions, proxied server-side so the key stays secret -- same reasoning as
 * api/places.js. Set GOOGLE_MAPS_API_KEY (or reuse GOOGLE_PLACES_API_KEY) in the Vercel
 * project environment variables and enable the Directions API on it.
 *
 * Smoke test after deploying:
 *   https://<your-app>.vercel.app/api/route?olat=35.22&olon=-80.84&dlat=35.59&dlon=-82.55
 *
 * If no key is configured this returns 503 and the page falls back to a straight-line
 * estimate, clearly labelled as one. Routing is an enhancement, not a dependency: a
 * planned trip is cached with its geometry, so the ride works with no signal afterwards.
 */

const MAX_WAYPOINTS = 4;

function decodePolyline(encoded) {
  // Google's encoded polyline, decoded here so the browser gets plain coordinates.
  const points = [];
  let index = 0, lat = 0, lon = 0;
  while (index < encoded.length) {
    let result = 0, shift = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

const stripTags = html => String(html || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

export default async function handler(req, res) {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    return res.status(503).json({
      error: 'Road routing is not configured for this deployment.',
      hint: 'Set GOOGLE_MAPS_API_KEY (or GOOGLE_PLACES_API_KEY) in the Vercel project '
          + 'environment variables, with the Directions API enabled on that key.'
    });
  }

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const oLat = num(req.query.olat), oLon = num(req.query.olon);
  const dLat = num(req.query.dlat), dLon = num(req.query.dlon);
  if ([oLat, oLon, dLat, dLon].some(v => v === null)
      || Math.abs(oLat) > 90 || Math.abs(dLat) > 90
      || Math.abs(oLon) > 180 || Math.abs(dLon) > 180) {
    return res.status(400).json({ error: 'olat, olon, dlat and dlon are required.' });
  }

  // Optional via points, "lat,lon|lat,lon". Bounded so this cannot be used to run up
  // arbitrary billable requests.
  const via = String(req.query.via || '').split('|').filter(Boolean).slice(0, MAX_WAYPOINTS);

  const params = new URLSearchParams({
    origin: `${oLat},${oLon}`,
    destination: `${dLat},${dLon}`,
    mode: 'driving',
    units: 'imperial',
    key
  });
  if (via.length) params.set('waypoints', via.join('|'));

  try {
    const upstream = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params}`);
    const data = await upstream.json();
    if (data.status !== 'OK' || !data.routes?.length) {
      return res.status(502).json({
        error: 'No route found.',
        detail: data.error_message || data.status
      });
    }
    const route = data.routes[0];
    const legs = (route.legs || []).map(leg => ({
      distance_mi: leg.distance ? +(leg.distance.value / 1609.344).toFixed(1) : null,
      duration_min: leg.duration ? Math.round(leg.duration.value / 60) : null,
      start: [leg.start_location.lat, leg.start_location.lng],
      end: [leg.end_location.lat, leg.end_location.lng],
      steps: (leg.steps || []).map(s => ({
        text: stripTags(s.html_instructions),
        distance_mi: s.distance ? +(s.distance.value / 1609.344).toFixed(2) : null
      }))
    }));

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      source: 'google-directions',
      distance_mi: +legs.reduce((a, l) => a + (l.distance_mi || 0), 0).toFixed(1),
      duration_min: legs.reduce((a, l) => a + (l.duration_min || 0), 0),
      polyline: decodePolyline(route.overview_polyline?.points || ''),
      legs
    });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the routing service.',
                                  detail: String(e) });
  }
}
