const STATUS_MAP = {
  // Docker/service states
  running:    { label: 'Running',   cls: 'badge-green'  },
  active:     { label: 'Active',    cls: 'badge-green'  },
  healthy:    { label: 'Healthy',   cls: 'badge-green'  },
  stopped:    { label: 'Stopped',   cls: 'badge-red'    },
  inactive:   { label: 'Inactive',  cls: 'badge-red'    },
  exited:     { label: 'Exited',    cls: 'badge-red'    },
  failed:     { label: 'Failed',    cls: 'badge-red'    },
  restarting: { label: 'Restarting',cls: 'badge-yellow' },
  unhealthy:  { label: 'Unhealthy', cls: 'badge-yellow' },
  starting:   { label: 'Starting',  cls: 'badge-yellow' },
  paused:     { label: 'Paused',    cls: 'badge-yellow' },
  unknown:    { label: 'Unknown',   cls: 'badge-gray'   },
  'N/A':      { label: 'N/A',       cls: 'badge-gray'   },

  // Incident states
  detected:          { label: 'Detected',          cls: 'badge-yellow' },
  investigating:     { label: 'Investigating',     cls: 'badge-yellow' },
  diagnosed:         { label: 'Diagnosed',          cls: 'badge-blue'   },
  awaiting_approval: { label: 'Awaiting Approval',  cls: 'badge-blue'   },
  remediating:       { label: 'Remediating',        cls: 'badge-blue'   },
  verifying:         { label: 'Verifying',          cls: 'badge-blue'   },
  resolved:          { label: 'Resolved',           cls: 'badge-green'  },
  dismissed:         { label: 'Dismissed',          cls: 'badge-gray'   }
};

export default function StatusBadge({ status }) {
  const key = (status || 'unknown').toLowerCase();
  const { label, cls } = STATUS_MAP[key] || { label: status, cls: 'badge-gray' };
  const dotColor = cls === 'badge-green'
    ? 'var(--green)' : cls === 'badge-red'
    ? 'var(--red)' : cls === 'badge-yellow'
    ? 'var(--yellow)' : 'var(--text-dim)';

  return (
    <span className={`badge ${cls}`}>
      <span className="badge-dot" style={{ background: dotColor }} />
      {label}
    </span>
  );
}
