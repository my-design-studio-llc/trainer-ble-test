// Elevation profile strip with the rider's position.

export class ElevationProfile {
  constructor(canvas, route) {
    this.canvas = canvas;
    this.route = route;
    this.ctx = canvas.getContext('2d');
    let min = Infinity;
    let max = -Infinity;
    for (const e of route.ele) {
      min = Math.min(min, e);
      max = Math.max(max, e);
    }
    this.min = min;
    this.max = Math.max(max, min + 20);
  }

  /** `dragging` shows the distance next to the marker while the rider is being moved. */
  draw(d, { dragging = false } = {}) {
    const { canvas, ctx, route } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const x = (dist) => (dist / route.total) * w;
    const y = (ele) => h - 4 - ((ele - this.min) / (this.max - this.min)) * (h - 8);
    const stride = Math.max(1, Math.floor(route.n / w));

    const path = new Path2D();
    path.moveTo(0, h);
    for (let i = 0; i < route.n; i += stride) path.lineTo(x(route.dist[i]), y(route.ele[i]));
    path.lineTo(w, y(route.ele[route.n - 1]));
    path.lineTo(w, h);
    path.closePath();

    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fill(path);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, x(d), h);
    ctx.clip();
    ctx.fillStyle = 'rgba(252,82,0,0.75)';
    ctx.fill(path);
    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.fillRect(x(d) - 1, 0, 2, h);

    // Tap/drag hint and live distance readout.
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    if (dragging) {
      const label = `${(d / 1000).toFixed(2)} km`;
      const tw = ctx.measureText(label).width + 10;
      const lx = Math.min(Math.max(0, x(d) - tw / 2), w - tw);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(lx, 2, tw, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, lx + 5, 4);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.textAlign = 'right';
      ctx.fillText('drag to move', w - 6, 4);
      ctx.textAlign = 'left';
    }
  }
}
