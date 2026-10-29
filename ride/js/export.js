// File exports: the route's coordinates, and the virtual ride as TCX for uploading.

import { routeRows, routeToCSV } from './geo.js';

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => s.replace(/[^\w-]+/g, '_').slice(0, 60) || 'route';

export function exportRouteCSV(route) {
  download(`${slug(route.name)}.csv`, routeToCSV(route), 'text/csv');
}

export function exportRouteJSON(route) {
  const body = { name: route.name, step: route.step, distance: route.total, points: routeRows(route) };
  download(`${slug(route.name)}.json`, JSON.stringify(body), 'application/json');
}

/**
 * @param samples {{ time: Date, lat, lng, ele, distance, speed, power?, cadence?, hr? }[]}
 */
export function exportRideTCX(name, samples) {
  if (!samples.length) return;
  const start = samples[0].time.toISOString();
  const last = samples[samples.length - 1];
  const seconds = (last.time - samples[0].time) / 1000;
  const points = samples
    .map(
      (s) => `        <Trackpoint>
          <Time>${s.time.toISOString()}</Time>
          <Position><LatitudeDegrees>${s.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${s.lng.toFixed(7)}</LongitudeDegrees></Position>
          <AltitudeMeters>${s.ele.toFixed(1)}</AltitudeMeters>
          <DistanceMeters>${s.distance.toFixed(1)}</DistanceMeters>${
            s.hr ? `\n          <HeartRateBpm><Value>${Math.round(s.hr)}</Value></HeartRateBpm>` : ''
          }${s.cadence !== undefined ? `\n          <Cadence>${Math.round(s.cadence)}</Cadence>` : ''}
          <Extensions><ns3:TPX><ns3:Speed>${s.speed.toFixed(2)}</ns3:Speed>${
            s.power !== undefined ? `<ns3:Watts>${Math.round(s.power)}</ns3:Watts>` : ''
          }</ns3:TPX></Extensions>
        </Trackpoint>`,
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${start}</Id>
      <Lap StartTime="${start}">
        <TotalTimeSeconds>${seconds.toFixed(0)}</TotalTimeSeconds>
        <DistanceMeters>${last.distance.toFixed(1)}</DistanceMeters>
        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
        <Track>
${points}
        </Track>
      </Lap>
      <Notes>${escapeXml(`Virtual ride: ${name}`)}</Notes>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
  download(`virtual_${slug(name)}_${start.slice(0, 10)}.tcx`, xml, 'application/vnd.garmin.tcx+xml');
}

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}
