// Route outline with the rider's position, drawn on a canvas (no map provider needed).

export class CanvasMiniMap {
  constructor(container, route) {
    this.route = route;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;background:rgba(10,12,15,0.72)';
    container.replaceChildren(this.canvas);
    const k = Math.cos((route.lat[0] * Math.PI) / 180);
    this.xs = Array.from(route.lng, (v) => v * k);
    this.ys = Array.from(route.lat, (v) => -v);
    this.bounds = {
      minX: Math.min(...this.xs),
      maxX: Math.max(...this.xs),
      minY: Math.min(...this.ys),
      maxY: Math.max(...this.ys),
    };
    this.k = k;
  }

  update(lat, lng) {
    const { canvas, bounds: b } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pad = 12;
    const s = Math.min((w - pad * 2) / (b.maxX - b.minX || 1e-9), (h - pad * 2) / (b.maxY - b.minY || 1e-9));
    const ox = (w - (b.maxX - b.minX) * s) / 2;
    const oy = (h - (b.maxY - b.minY) * s) / 2;
    const X = (x) => ox + (x - b.minX) * s;
    const Y = (y) => oy + (y - b.minY) * s;

    ctx.strokeStyle = '#fc5200';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const stride = Math.max(1, Math.floor(this.xs.length / 1500));
    for (let i = 0; i < this.xs.length; i += stride) {
      if (i === 0) ctx.moveTo(X(this.xs[i]), Y(this.ys[i]));
      else ctx.lineTo(X(this.xs[i]), Y(this.ys[i]));
    }
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fc5200';
    ctx.beginPath();
    ctx.arc(X(lng * this.k), Y(-lat), 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
