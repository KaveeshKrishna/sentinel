import { useEffect, useState, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import sentinelLogo from '../assets/logo/sentinel-logo-light.svg';
import sentinelLogoText from '../assets/logo/sentinel-logo-text-light.svg';
import RecordingControl from '../components/recording/RecordingControl';
import ToastHost from '../components/shared/ToastHost';
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
import Incidents   from '../components/sections/Incidents';
import AskSentinel from '../components/sections/AskSentinel';
import IncidentDetail from '../components/sections/IncidentDetail';
import Settings    from '../components/sections/Settings';
import Health      from '../components/sections/Health';
import About       from '../components/sections/About';
import { useAuth, apiLogout } from '../hooks/useAuth';

// Demo-only badge + notice. Dynamically imported behind the build flag so
// nothing under src/demo/ lands in the normal bundle.
const DemoBadge = import.meta.env.VITE_DEMO
  ? lazy(() => import('../demo/DemoNotice.jsx').then(m => ({ default: m.DemoBadge })))
  : null;
import { useMetrics, useLiveEvents } from '../hooks/useWebSocket';
import { api } from '../api/client';

const TERMINAL_STATES = ['RESOLVED', 'FAILED', 'DISMISSED'];

/**
 * Count of incidents still needing attention, for the sidebar badge.
 * Refetched whenever the server pushes an incident change, so the badge
 * tracks reality without its own poll.
 */
function useOpenIncidentCount() {
  const { incidentTick } = useLiveEvents();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.get('/incidents')
      .then(list => {
        if (!cancelled) setCount(list.filter(i => !TERMINAL_STATES.includes(i.status)).length);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [incidentTick]);

  return count;
}

const TABS = [
  { id: 'overview',     label: 'Overview',     icon: 'grid',        group: 'Monitor' },
  { id: 'incidents',    label: 'Incidents',    icon: 'alert',       group: 'Monitor' },
  { id: 'ask',          label: 'Ask Sentinel',  icon: 'sparkles',   group: 'Monitor' },
  { id: 'hardware',     label: 'Hardware',      icon: 'cpu',        group: 'Monitor' },
  { id: 'docker',       label: 'Docker',        icon: 'box',        group: 'Monitor' },
  { id: 'websites',     label: 'Websites',      icon: 'globe',      group: 'Monitor' },
  { id: 'network',      label: 'Network',       icon: 'activity',   group: 'Monitor' },
  { id: 'storage',      label: 'Storage',       icon: 'database',   group: 'Monitor' },
  { id: 'services',     label: 'Services',      icon: 'layers',     group: 'Manage' },
  { id: 'deployments',  label: 'Deployments',   icon: 'git-branch', group: 'Manage' },
  { id: 'activity',     label: 'Activity',      icon: 'clock',      group: 'Manage' },
  { id: 'recordings',   label: 'Recordings',    icon: 'record',     group: 'Manage' },
  { id: 'sentinel-health', label: 'Sentinel Health', icon: 'pulse', group: 'Manage' },
  { id: 'settings',     label: 'Settings',      icon: 'settings',   group: 'Manage' },
  { id: 'about',        label: 'About',         icon: 'shield',     group: 'Manage' }
];

const TAB_TITLES = {
  overview:    { title: 'System Overview',    subtitle: 'Live system health at a glance' },
  incidents:   { title: 'Incidents',          subtitle: 'AI-detected infrastructure incidents' },
  ask:         { title: 'Ask Sentinel',       subtitle: 'Ask about this host — answered with live read-only tools' },
  hardware:    { title: 'Hardware',           subtitle: 'CPU, memory, and disk details' },
  docker:      { title: 'Docker',             subtitle: 'Running and stopped containers' },
  websites:    { title: 'Websites',           subtitle: 'Hosted applications status' },
  network:     { title: 'Network',            subtitle: 'Bandwidth, IPs, and Caddy analytics' },
  storage:     { title: 'Storage',            subtitle: 'Disk usage and SSD status' },
  services:    { title: 'Services',           subtitle: 'System service control' },
  deployments: { title: 'Deployments',        subtitle: '/srv/apps git repositories' },
  activity:    { title: 'Activity Timeline',  subtitle: 'Most recent 50 system events' },
  recordings:  { title: 'Recordings',         subtitle: 'VPS health recording sessions' },
  'sentinel-health': { title: 'Sentinel Health', subtitle: 'Agent/database status and AI request spend' },
  settings:    { title: 'Settings',           subtitle: 'AI providers, detection thresholds and alerting' },
  about:       { title: 'About Sentinel',     subtitle: 'What it is, why it was built, and who by' }
};

const GROUPS = ['Monitor', 'Manage'];

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
    record:<><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/></>,
    message:<><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></>,
    alert:<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>,
    settings:<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    pulse:<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>,
    sparkles:<><path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z"/><path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z"/></>
  };
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {icons[name]}
    </svg>
  );
}

export default function Dashboard() {
  const { setAuth } = useAuth();
  const { connected } = useMetrics() || {};
  const navigate = useNavigate();
  const location = useLocation();
  const openIncidents = useOpenIncidentCount();

  // Desktop/tablet: collapsible to an icon rail, remembered across visits.
  // Mobile: an off-canvas drawer instead — see the .sidebar-wrap media
  // queries. Both live on the same element; only one behaviour is active
  // at a given viewport width.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('sentinel-sidebar-collapsed') === '1'; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem('sentinel-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
  }, [collapsed]);

  // Close the mobile drawer on every navigation, including the one caused
  // by clicking a nav link inside it.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const activeTab = location.pathname.split('/')[1] || 'overview';
  const info = TAB_TITLES[activeTab] || TAB_TITLES.overview;

  async function handleLogout() {
    await apiLogout();
    setAuth(false);
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}

      <div className={`sidebar-wrap ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
        <aside className="sidebar">
          <div className="sidebar-brand">
            <img src={sentinelLogo} alt="" className="sidebar-brand-icon" />
            <img src={sentinelLogoText} alt="Sentinel" className="sidebar-brand-full" />
          </div>

          <nav className="sidebar-nav">
            {GROUPS.map(group => (
              <div key={group}>
                <div className="nav-section-label" style={group !== GROUPS[0] ? { marginTop: 8 } : undefined}>{group}</div>
                {TABS.filter(t => t.group === group).map(tab => (
                  <NavLink
                    key={tab.id}
                    id={`nav-${tab.id}`}
                    to={`/${tab.id}`}
                    title={collapsed ? tab.label : undefined}
                    className={({ isActive }) => `nav-item ${isActive ? 'active' : ''} ${tab.id === 'ask' ? 'nav-item-ai' : ''}`}
                  >
                    <NavIcon name={tab.icon} />
                    <span className="nav-label">{tab.label}</span>
                    {tab.id === 'incidents' && openIncidents > 0 && (
                      <span className="nav-badge" id="nav-incidents-count">{openIncidents}</span>
                    )}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          <div className="sidebar-footer">
            <button
              id="btn-logout"
              className="nav-item"
              title={collapsed ? 'Logout' : undefined}
              onClick={handleLogout}
              style={{ color: 'var(--text-dim)', width: '100%', borderRadius: 'var(--r)' }}
            >
              <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              <span className="nav-label">Logout</span>
            </button>
          </div>
        </aside>

        <button
          id="btn-sidebar-collapse"
          className="sidebar-toggle"
          onClick={() => setCollapsed(c => !c)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      <div className="main-content">
        {/* Live incident toasts (fixed overlay, renders nothing when idle) */}
        <ToastHost />

        {/* Section header — title on the left; connection status and
            recording controls together on the right, in that order, so
            the live indicator always sits immediately left of whichever
            recording button is showing. */}
        <div className="content-header">
          <div className="content-header-left">
            <button
              id="btn-mobile-menu"
              className="mobile-menu-btn"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <div className="content-header-titles">
              <div className="content-title">{info.title}</div>
              <div className="content-subtitle">{info.subtitle}</div>
            </div>
          </div>
          <div className="content-header-right">
            {DemoBadge && <Suspense fallback={null}><DemoBadge compact autoOpen /></Suspense>}
            <div className="ws-badge">
              <div className={`ws-dot ${connected ? '' : 'off'}`} />
              {connected ? 'Live' : 'Reconnecting…'}
            </div>
            <RecordingControl />
          </div>
        </div>

        <div className="content-scroll">
          <Routes>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<Overview />} />
            <Route path="incidents" element={<Incidents />} />
            <Route path="incidents/:id" element={<IncidentDetail />} />
            <Route path="ask" element={<AskSentinel />} />
            <Route path="hardware" element={<Hardware />} />
            <Route path="docker" element={<DockerSection />} />
            <Route path="websites" element={<Websites />} />
            <Route path="network" element={<Network />} />
            <Route path="storage" element={<Storage />} />
            <Route path="services" element={<Services />} />
            <Route path="deployments" element={<Deployments />} />
            <Route path="activity" element={<Activity />} />
            <Route path="recordings" element={<Recordings />} />
            <Route path="sentinel-health" element={<Health />} />
            <Route path="settings" element={<Settings />} />
            <Route path="about" element={<About />} />
            <Route path="*" element={<Navigate to="overview" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
