// File exports: the route's coordinates, and the virtual ride as FIT for uploading.

import { routeRows, routeToCSV } from './geo.js';
import { rideFIT } from './fit.js';

const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Saves text or bytes as a file. */
export async function download(filename, data, type = 'text/plain') {
  // iOS browsers built on WKWebView (Bluefy) ignore <a download>: hand the file to the share
  // sheet ("Save to Files", AirDrop, mail…) or, failing that, open it in a tab to save from there.
  if (isIOS()) {
    const shareType = typeof data === 'string' ? 'text/plain' : 'application/octet-stream';
    const file = new File([data], filename, { type: shareType });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        // Files only: a title or text would be saved as a second (.txt) file.
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // the rider closed the share sheet
      }
    }
    const url = URL.createObjectURL(new Blob([data], { type: shareType }));
    if (window.open(url, '_blank')) return setTimeout(() => URL.revokeObjectURL(url), 60000);
    URL.revokeObjectURL(url);
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
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

/** The ride as a FIT file (Strava, Garmin Connect, intervals.icu…), marked as a virtual ride. */
export function rideFitFile(name, samples) {
  const start = samples[0].time.toISOString();
  return { filename: `virtual_${slug(name)}_${start.replace(/[:.]/g, '-').slice(0, 19)}.fit`, data: rideFIT(samples), dataType: 'fit' };
}

export function exportRideFIT(name, samples) {
  if (!samples.length) return;
  const { filename, data } = rideFitFile(name, samples);
  download(filename, data, 'application/vnd.ant.fit');
}
