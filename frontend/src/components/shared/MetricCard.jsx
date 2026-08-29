import Sparkline from './Sparkline';
import Icon from './Icon';

const COLOR_MAP = {
  blue:   '#3b82f6',
  green:  '#22c55e',
  yellow: '#f59e0b',
  red:    '#ef4444',
  purple: '#a855f7',
  cyan:   '#06b6d4'
};

export default function MetricCard({ title, value, unit, sub, color = 'blue', icon, sparklineData }) {
  const c = COLOR_MAP[color] || color;

  return (
    <div className="metric-card">
      <div className="metric-header">
        <div className="metric-icon" style={{ background: `${c}18`, color: c }}>
          <Icon name={icon} size={16} />
        </div>
        <span className="metric-label">{title}</span>
      </div>

      <div className="metric-value">
        {value ?? '—'}
        {unit && <span className="metric-unit">{unit}</span>}
      </div>

      {sub && <div className="metric-sub">{sub}</div>}

      {sparklineData && (
        <div className="metric-sparkline">
          <Sparkline data={sparklineData} color={c} height={36} />
        </div>
      )}
    </div>
  );
}
