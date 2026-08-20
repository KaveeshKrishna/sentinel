import { useState } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import RecordingControl from '../components/recording/RecordingControl';
import Overview    from '../components/sections/Overview';
import Hardware    from '../components/sections/Hardware';
import DockerSection from '../components/sections/DockerSection';
import Websites    from '../components/sections/Websites';
import Network     from '../components/sections/Network';
import Storage     from '../components/sections/Storage';
import Services    from '../components/sections/Services';
import Deployments from '../components/sections/Deployments';
import Activity    from '../components/sections/Activity';
import Recordings  from '../components/sections/Recordings';
import { useAuth, apiLogout } from '../hooks/useAuth';
import { useMetrics } from '../hooks/useWebSocket';

const TABS = [
  { id: 'overview',     label: 'Overview',     icon: 'grid' },
  { id: 'hardware',     label: 'Hardware',      icon: 'cpu' },
  { id: 'docker',       label: 'Docker',        icon: 'box' },
  { id: 'websites',     label: 'Websites',      icon: 'globe' },
  { id: 'network',      label: 'Network',       icon: 'activity' },
  { id: 'storage',      label: 'Storage',       icon: 'database' },
  { id: 'services',     label: 'Services',      icon: 'layers' },
  { id: 'deployments',  label: 'Deployments',   icon: 'git-branch' },
  { id: 'activity',     label: 'Activity',      icon: 'clock' },
  { id: 'recordings',   label: 'Recordings',    icon: 'record' }
];

const TAB_TITLES = {
  overview:    { title: 'System Overview',    subtitle: 'Live system health at a glance' },
  hardware:    { title: 'Hardware',           subtitle: 'CPU, memory, and disk details' },
  docker:      { title: 'Docker',             subtitle: 'Running and stopped containers' },
  websites:    { title: 'Websites',           subtitle: 'Hosted applications status' },
  network:     { title: 'Network',            subtitle: 'Bandwidth, IPs, and Caddy analytics' },
  storage:     { title: 'Storage',            subtitle: 'Disk usage and SSD status' },
  services:    { title: 'Services',           subtitle: 'System service control' },
  deployments: { title: 'Deployments',        subtitle: '/srv/apps git repositories' },
  activity:    { title: 'Activity Timeline',  subtitle: 'Last 500 system events' },
  recordings:  { title: 'Recordings',         subtitle: 'VPS health recording sessions' }
};

function NavIcon({ name }) {
  const icons = {
    grid: <path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/>,
    cpu:  <><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></>,
    box:  <><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></>,
    globe:<><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></>,
    activity:<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>,
    database:<><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></>,
    layers:<><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></>,
    'git-branch':<><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></>,
    clock:<><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
    record:<><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/>
    </>
  };
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {icons[name]}
    </svg>
  );
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState('overview');
  const { setAuth } = useAuth();
  const { connected } = useMetrics() || {};
  const navigate = useNavigate();

  const info = TAB_TITLES[activeTab];

  async function handleLogout() {
    await apiLogout();
    setAuth(false);
  }

  const SECTION_MAP = {
    overview:    <Overview />,
    hardware:    <Hardware />,
    docker:      <DockerSection />,
    websites:    <Websites />,
    network:     <Network />,
    storage:     <Storage />,
    services:    <Services />,
    deployments: <Deployments />,
    activity:    <Activity />,
    recordings:  <Recordings />
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
          <span className="sidebar-brand-name">Sentinel</span>
          <div className={`sidebar-brand-dot ${connected ? '' : 'offline'}`} style={{ marginLeft: 'auto' }} />
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section-label">Monitor</div>
          {TABS.slice(0, 6).map(tab => (
            <button
              key={tab.id}
              id={`nav-${tab.id}`}
              className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <NavIcon name={tab.icon} />
              <span>{tab.label}</span>
            </button>
          ))}

          <div className="nav-section-label" style={{ marginTop: 8 }}>Manage</div>
          {TABS.slice(6).map(tab => (
            <button
              key={tab.id}
              id={`nav-${tab.id}`}
              className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <NavIcon name={tab.icon} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            id="btn-logout"
            className="nav-item"
            onClick={handleLogout}
            style={{ color: 'var(--text-dim)', width: '100%', borderRadius: 'var(--r)' }}
          >
            <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            <span>Logout</span>
          </button>
        </div>
      </aside>

      <div className="main-content">
        {/* Recording banner (always visible) */}
        <RecordingControl />

        {/* Section header */}
        <div className="content-header">
          <div>
            <div className="content-title">{info.title}</div>
            <div className="content-subtitle">{info.subtitle}</div>
          </div>
          <div className="ws-badge">
            <div className={`ws-dot ${connected ? '' : 'off'}`} />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
        </div>

        <div className="content-scroll">
          {SECTION_MAP[activeTab]}
        </div>
      </div>
    </div>
  );
}
