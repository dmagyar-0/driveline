// wf-parts.jsx — shared building blocks for Driveline wireframes.
// Sidebar rail, drawer, transport, and panel-content stubs.

const RailIcons = {
  sources:
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8V7a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1" />
      <path d="M3 13h18" />
    </svg>,

  channels:
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h13M3 12h18M3 18h10" />
      <circle cx="20" cy="6" r="1.5" fill="currentColor" />
    </svg>,

  layout:
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12h18M12 3v18" />
    </svg>,

  panel:
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 8h18" />
    </svg>,

  events:
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 22V4M4 4h13l-2 5 2 5H4" />
    </svg>

};

const PanelIcons = {
  full:
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>,

  collapse:
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
    </svg>,

  settings:
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.5-2.4.8a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.4a7 7 0 0 0-2 1.2l-2.4-.8-2 3.5 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.5 2.4-.8a7 7 0 0 0 2 1.2L10 21h4l.5-2.4a7 7 0 0 0 2-1.2l2.4.8 2-3.5-2-1.5c.1-.4.1-.8.1-1.2z" />
    </svg>,

  close:
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>,

  grip:
  <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
    </svg>

};

const RAIL_ITEMS = [
{ id: "sources", label: "Sources", icon: RailIcons.sources },
{ id: "channels", label: "Channels", icon: RailIcons.channels },
{ id: "layout", label: "Layout", icon: RailIcons.layout },
{ id: "panel", label: "Panel", icon: RailIcons.panel },
{ id: "events", label: "Events", icon: RailIcons.events }];


const TopBar = ({ title = "driveline" }) =>
<div className="wf-top">
    <img className="wf-logo" src="assets/logo.svg" width="22" height="22" alt="Driveline"/>
    <div className="wf-wordmark">{title}</div>
    <div className="meta">session · 00:10.418 ·  2 sources</div>
  </div>;


const Rail = ({ active, onPick, variant = "" }) =>
<nav className={"wf-rail " + variant}>
    {RAIL_ITEMS.map((it) =>
  <button
    key={it.id}
    className={"wf-rail-btn" + (active === it.id ? " active" : "")}
    onClick={() => onPick && onPick(it.id)}
    title={it.label}
    aria-label={it.label}>
    
        {it.icon}
      </button>
  )}
    <div className="wf-rail-spacer" />
  </nav>;


const SourcesDrawer = () =>
<div className="wf-drawer">
    <h3>Sources <span className="pill">2</span></h3>
    <div className="row active">
      <span className="swatch" style={{ background: "var(--color-accent-orange)" }} />
      drive_07.mcap
      <span className="meta">MCAP</span>
    </div>
    <div className="row">
      <span className="swatch" style={{ background: "var(--plot-3)" }} />
      front_cam.mp4
      <span className="meta">MP4+TS</span>
    </div>
    <button className="add-btn">+ drop / load file…</button>
    <div className="sep" />
    <h3>Global range</h3>
    <div className="row" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
      <span className="tag-handwritten">start</span>
      <span className="meta">0.000s</span>
    </div>
    <div className="row" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
      <span className="tag-handwritten">end</span>
      <span className="meta">10.418s</span>
    </div>
  </div>;


const ChannelsDrawer = () =>
<div className="wf-drawer">
    <h3>Channels <span className="pill">14</span></h3>
    <div className="row"><span className="swatch" style={{ background: "var(--plot-1)" }} />ego.speed<span className="meta">f64</span></div>
    <div className="row active"><span className="swatch" style={{ background: "var(--plot-2)" }} />ego.steering<span className="meta">f32</span></div>
    <div className="row"><span className="swatch" style={{ background: "var(--plot-3)" }} />imu.yaw<span className="meta">f32</span></div>
    <div className="row"><span className="swatch" style={{ background: "var(--plot-4)" }} />brake.pressure<span className="meta">f32</span></div>
    <div className="row"><span className="swatch" style={{ background: "var(--plot-6)" }} />ego.gear<span className="meta">enum</span></div>
    <div className="row"><span className="swatch" style={{ background: "var(--plot-5)" }} />adas.state<span className="meta">enum</span></div>
    <div className="row"><span className="swatch" style={{ background: "var(--plot-7)" }} />can.0x18ff…<span className="meta">u32</span></div>
  </div>;


const LayoutDrawer = () =>
<div className="wf-drawer">
    <h3>Saved layouts</h3>
    <div className="row active">default · 4-pane<span className="meta">live</span></div>
    <div className="row">debug · plots only</div>
    <div className="row">video + map</div>
    <button className="add-btn">+ save current as…</button>
    <div className="sep" />
    <h3>Add panel</h3>
    <div className="row">+ video</div>
    <div className="row">+ plot</div>
    <div className="row">+ 3D scene</div>
    <div className="row">+ map</div>
    <div className="row">+ table</div>
  </div>;


const PanelDrawer = () =>
<div className="wf-drawer">
    <h3>front_cam <span className="pill">video</span></h3>
    <div className="row">decoder<span className="meta">h264</span></div>
    <div className="row">step-hold<span className="meta">on</span></div>
    <div className="row">HUD overlay<span className="meta">on</span></div>
    <div className="sep" />
    <h3>Channels in panel</h3>
    <div className="row"><span className="swatch" style={{ background: "var(--plot-2)" }} />front.h264</div>
    <button className="add-btn">+ add channel…</button>
  </div>;


const EventsDrawer = () =>
<div className="wf-drawer">
    <h3>Bookmarks <span className="pill">3</span></h3>
    <div className="row"><span className="swatch" style={{ background: "var(--color-accent-orange)" }} />hard brake<span className="meta">3.412</span></div>
    <div className="row active"><span className="swatch" style={{ background: "var(--plot-1)" }} />lane change L<span className="meta">5.880</span></div>
    <div className="row"><span className="swatch" style={{ background: "var(--plot-3)" }} />stop sign<span className="meta">7.215</span></div>
    <button className="add-btn">+ bookmark at cursor</button>
  </div>;


const DRAWERS = {
  sources: SourcesDrawer,
  channels: ChannelsDrawer,
  layout: LayoutDrawer,
  panel: PanelDrawer,
  events: EventsDrawer
};

const Drawer = ({ tab }) => {
  const D = DRAWERS[tab] || SourcesDrawer;
  return <D />;
};

// ─── Panel ─────────────────────────────────────────────────────
const PanelHead = ({ title, kind, selected, showGrip = true, showKind = true }) =>
<div className="wf-panel-head">
    {showGrip && <span className="grip">{PanelIcons.grip}</span>}
    <span className="title">{title}</span>
    {showKind && <span className="kind">{kind}</span>}
    <span className="icons">
      <button className="ic" title="Settings">{PanelIcons.settings}</button>
      <button className="ic" title="Collapse">{PanelIcons.collapse}</button>
      <button className="ic" title="Fullscreen">{PanelIcons.full}</button>
      <button className="ic" title="Close">{PanelIcons.close}</button>
    </span>
  </div>;


const Panel = ({ title, kind, selected, chrome = "always", children }) =>
<div className={"wf-panel" + (selected ? " selected" : "") + " chrome-" + chrome}>
    <PanelHead title={title} kind={kind} selected={selected} />
    <div className="wf-panel-body">{children}</div>
  </div>;


// ─── Stubs ──────────────────────────────────────────────────────
const VideoStub = () =>
<div className="wf-stub video">
    <span className="stub-label">video · 1920×1080</span>
    <div className="frame">[ frame ]</div>
    <span className="hud">pts=12345678ns frame=304 q=2</span>
  </div>;


const PlotStub = ({ color = "var(--plot-1)", label = "ego.speed" }) =>
<div className="wf-stub plot">
    <span className="stub-label">{label}</span>
    <svg width="100%" height="100%" viewBox="0 0 300 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0 }}>
      <line x1="0" y1="80" x2="300" y2="80" stroke="#1f1f1f" strokeWidth="0.5" />
      <line x1="0" y1="50" x2="300" y2="50" stroke="#1f1f1f" strokeWidth="0.5" />
      <line x1="0" y1="20" x2="300" y2="20" stroke="#1f1f1f" strokeWidth="0.5" />
      <path d="M0,70 C30,60 50,30 80,32 S130,80 170,55 220,18 260,28 290,55 300,48"
    fill="none" stroke={color} strokeWidth="1.5" />
      <line x1="115" y1="0" x2="115" y2="100" stroke="var(--color-accent-blue)" strokeWidth="0.7" strokeDasharray="2 2" />
    </svg>
  </div>;


const SceneStub = () =>
<div className="wf-stub scene">
    <span className="stub-label">3D scene · point cloud</span>
    <svg viewBox="0 0 300 200" preserveAspectRatio="xMidYMid meet">
      {/* ground plane */}
      <g stroke="#2a2a2a" strokeWidth="0.5" fill="none">
        <path d="M40,150 L260,150 L210,180 L90,180 Z" />
        <path d="M70,165 L230,165" />
        <path d="M120,150 L100,180 M150,150 L150,180 M180,150 L200,180" />
      </g>
      {/* axes */}
      <g strokeWidth="1.2" fill="none">
        <line x1="150" y1="160" x2="150" y2="100" stroke="#10b981" />
        <line x1="150" y1="160" x2="200" y2="170" stroke="#ef4444" />
        <line x1="150" y1="160" x2="105" y2="175" stroke="#3b82f6" />
      </g>
      {/* points */}
      <g fill="#bbb">
        {Array.from({ length: 60 }).map((_, i) => {
        const x = 60 + i * 17 % 200 + i % 3 * 4;
        const y = 100 + i * 9 % 70;
        return <circle key={i} cx={x} cy={y} r={i % 5 === 0 ? 1.5 : 0.8} />;
      })}
      </g>
      <text x="155" y="100" fontFamily="ui-monospace, monospace" fontSize="7" fill="#666">z</text>
      <text x="202" y="172" fontFamily="ui-monospace, monospace" fontSize="7" fill="#666">x</text>
      <text x="98" y="178" fontFamily="ui-monospace, monospace" fontSize="7" fill="#666">y</text>
    </svg>
  </div>;


const MapStub = () =>
<div className="wf-stub map">
    <span className="stub-label">map · trajectory</span>
    <svg viewBox="0 0 300 200" preserveAspectRatio="xMidYMid meet">
      <g stroke="#1f1f1f" strokeWidth="0.5">
        {Array.from({ length: 9 }).map((_, i) =>
      <line key={"h" + i} x1="0" y1={20 * i + 10} x2="300" y2={20 * i + 10} />
      )}
        {Array.from({ length: 14 }).map((_, i) =>
      <line key={"v" + i} x1={22 * i + 10} y1="0" x2={22 * i + 10} y2="200" />
      )}
      </g>
      <path d="M30,170 Q60,150 80,130 T130,90 Q160,70 190,80 T260,40"
    fill="none" stroke="var(--plot-3)" strokeWidth="1.6" />
      <circle cx="120" cy="98" r="3" fill="var(--color-accent-orange)" stroke="#000" strokeWidth="1" />
      <text x="128" y="95" fontFamily="ui-monospace, monospace" fontSize="8" fill="#888">ego</text>
    </svg>
  </div>;


const TableStub = () =>
<div className="wf-stub table">
    <span className="stub-label">log table</span>
    <div className="grid" style={{ marginTop: 14 }}>
      <div className="h">time</div><div className="h">channel</div><div className="h">value</div><div className="h">src</div>
      <div>3.412</div><div>brake.pressure</div><div>0.84</div><div>mcap</div>
      <div>3.510</div><div>ego.speed</div><div>12.3 m/s</div><div>mcap</div>
      <div>3.620</div><div>adas.state</div><div>FOLLOWING</div><div>mcap</div>
      <div>3.701</div><div>ego.gear</div><div>D</div><div>mcap</div>
      <div>3.810</div><div>imu.yaw</div><div>-0.11</div><div>mcap</div>
      <div>3.920</div><div>ego.steering</div><div>0.32</div><div>mcap</div>
    </div>
  </div>;


// Enum state-change strip — each state a color block.
const EnumStub = () => {
  const lanes = [
  { name: "adas.state", segs: [
    { w: 18, c: "var(--plot-5)", t: "OFF" },
    { w: 22, c: "var(--plot-1)", t: "ARMED" },
    { w: 32, c: "var(--plot-3)", t: "FOLLOWING" },
    { w: 12, c: "var(--plot-4)", t: "BRAKE" },
    { w: 16, c: "var(--plot-3)", t: "FOLLOW" }]
  },
  { name: "ego.gear", segs: [
    { w: 10, c: "var(--plot-6)", t: "P" },
    { w: 8, c: "var(--plot-7)", t: "R" },
    { w: 14, c: "var(--plot-6)", t: "N" },
    { w: 60, c: "var(--plot-3)", t: "D" },
    { w: 8, c: "var(--plot-6)", t: "N" }]
  },
  { name: "lane.side", segs: [
    { w: 30, c: "var(--plot-1)", t: "L" },
    { w: 40, c: "var(--plot-8)", t: "CENTER" },
    { w: 30, c: "var(--plot-2)", t: "R" }]
  }];

  return (
    <div className="wf-stub enum">
      <span className="stub-label">enum state changes</span>
      <div className="strip" style={{ marginTop: 14 }}>
        {lanes.map((l, i) =>
        <React.Fragment key={i}>
            <div className="lane-label">{l.name}</div>
            <div className="lane">
              {l.segs.map((s, j) =>
            <span key={j} style={{ flex: s.w, background: s.c }}>{s.t}</span>
            )}
            </div>
          </React.Fragment>
        )}
      </div>
    </div>);

};

// ─── Transport ─────────────────────────────────────────────────
const Transport = () =>
<div className="wf-transport">
    <div className="btns">
      <button className="btn-t" title="Prev" style={{ width: "28px" }}>◀◀</button>
      <button className="btn-t play" title="Play">▶</button>
      <button className="btn-t" title="Next" style={{ width: "28px" }}>▶▶</button>
    </div>
    <span className="time">00:03.612</span>
    <div className="scrub" />
    <span className="time">00:10.418</span>
    <span className="speed">1×</span>
  </div>;


Object.assign(window, {
  Rail, Drawer, TopBar, Panel,
  VideoStub, PlotStub, SceneStub, MapStub, TableStub, EnumStub,
  Transport, RAIL_ITEMS
});