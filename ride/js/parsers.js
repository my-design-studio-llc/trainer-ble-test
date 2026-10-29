// GPX / TCX parsing (exports from ride apps and bike computers).

export function parseTrackFile(text, filename = '') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not parse file as XML');

  const lower = filename.toLowerCase();
  const isTcx = lower.endsWith('.tcx') || doc.documentElement.localName === 'TrainingCenterDatabase';
  const points = isTcx ? parseTcx(doc) : parseGpx(doc);
  if (points.length < 2) throw new Error('No track points found in file');

  const name =
    firstText(doc, isTcx ? 'Id' : 'name') || filename.replace(/\.(gpx|tcx)$/i, '') || 'Imported ride';
  return { name, points: relativeTimes(points) };
}

function parseGpx(doc) {
  let nodes = byTag(doc, 'trkpt');
  if (!nodes.length) nodes = byTag(doc, 'rtept');
  return nodes.map((el) => ({
    lat: parseFloat(el.getAttribute('lat')),
    lng: parseFloat(el.getAttribute('lon')),
    ele: num(firstText(el, 'ele')),
    time: firstText(el, 'time'),
  }));
}

function parseTcx(doc) {
  return byTag(doc, 'Trackpoint')
    .filter((el) => byTag(el, 'Position').length)
    .map((el) => ({
      lat: parseFloat(firstText(el, 'LatitudeDegrees')),
      lng: parseFloat(firstText(el, 'LongitudeDegrees')),
      ele: num(firstText(el, 'AltitudeMeters')),
      time: firstText(el, 'Time'),
    }));
}

function relativeTimes(points) {
  const t0 = Date.parse(points[0].time);
  return points.map(({ time, ...p }) => {
    const t = Date.parse(time);
    return { ...p, t: Number.isFinite(t0) && Number.isFinite(t) ? (t - t0) / 1000 : undefined };
  });
}

const byTag = (root, tag) => Array.from(root.getElementsByTagNameNS('*', tag));
const firstText = (root, tag) => byTag(root, tag)[0]?.textContent?.trim() ?? '';
const num = (s) => (s === '' ? undefined : parseFloat(s));
