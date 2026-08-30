/**
 * Lightweight SVG sparkline — no external deps.
 * Renders a filled area + line for up to 60 data points.
 */
export default function Sparkline({ data = [], color = '#3b82f6', height = 36 }) {
  if (!data || data.length < 2) {
    return <div className="metric-sparkline" style={{ height }} />;
  }

  const W = 200;
  const H = height;
  const valid = data.filter(v => v != null && !isNaN(v));
  const max = Math.max(...valid, 0.001);
  const min = 0;
  const range = max - min || 1;

  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((( v ?? 0) - min) / range) * H * 0.85; // 0.85 = top padding
    return [x, y];
  });

  const lineD = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L${W},${H} L0,${H} Z`;

  const gradId = `sg-${color.replace('#', '')}`;

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradId})`} />
      <path d={lineD} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
