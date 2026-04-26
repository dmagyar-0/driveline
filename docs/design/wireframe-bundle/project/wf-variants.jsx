// wf-variants.jsx — the 4 variations.
// Each renders inside a fixed-size DCArtboard so they line up nicely.

const { Rail, Drawer, TopBar, Panel,
  VideoStub, PlotStub, SceneStub, MapStub, TableStub, EnumStub,
  Transport } = window;

// ── V1 · Standard rail (VS Code style, 4-pane balanced) ──────
const V1 = ({ collapsed, tab, setTab }) => (
  <div className="wf">
    <TopBar/>
    <div className={"wf-shell " + (collapsed ? "left-rail" : "left-open")}>
      <Rail active={tab} onPick={setTab}/>
      {!collapsed && <Drawer tab={tab}/>}
      <div className="wf-work cozy layout-a">
        <Panel title="front_cam" kind="video" selected>
          <VideoStub/>
        </Panel>
        <Panel title="ego.speed" kind="plot">
          <PlotStub color="var(--plot-1)" label="ego.speed (m/s)"/>
        </Panel>
        <Panel title="adas.state" kind="enum">
          <EnumStub/>
        </Panel>
      </div>
    </div>
    <Transport/>
  </div>
);

// ── V2 · Compact rail + hover-only panel chrome (clean canvas) ──
const V2 = ({ collapsed, tab, setTab }) => (
  <div className="wf">
    <TopBar/>
    <div className={"wf-shell " + (collapsed ? "compact-rail" : "compact-open")}>
      <Rail active={tab} onPick={setTab} variant="compact"/>
      {!collapsed && <Drawer tab={tab}/>}
      <div className="wf-work cozy layout-b">
        <Panel title="front_cam" kind="video" chrome="hover" selected>
          <VideoStub/>
        </Panel>
        <Panel title="lidar" kind="3d" chrome="hover">
          <SceneStub/>
        </Panel>
        <Panel title="ego.speed" kind="plot" chrome="hover">
          <PlotStub color="var(--plot-1)" label="ego.speed"/>
        </Panel>
        <Panel title="ego.steering" kind="plot" chrome="hover">
          <PlotStub color="var(--plot-2)" label="ego.steering"/>
        </Panel>
      </div>
    </div>
    <Transport/>
  </div>
);

// ── V3 · Right-side rail, denser layout ────────────────────────
const V3 = ({ collapsed, tab, setTab }) => (
  <div className="wf">
    <TopBar/>
    <div className={"wf-shell " + (collapsed ? "right-rail" : "right-open")}>
      <div className="wf-work dense layout-c">
        <Panel title="front_cam" kind="video">
          <VideoStub/>
        </Panel>
        <Panel title="map" kind="map" selected>
          <MapStub/>
        </Panel>
        <Panel title="ego.speed" kind="plot">
          <PlotStub color="var(--plot-1)" label="ego.speed"/>
        </Panel>
        <Panel title="adas.state" kind="enum">
          <EnumStub/>
        </Panel>
        <Panel title="log" kind="table">
          <TableStub/>
        </Panel>
      </div>
      {!collapsed && <Drawer tab={tab}/>}
      <Rail active={tab} onPick={setTab}/>
    </div>
    <Transport/>
  </div>
);

// ── V4 · Wide rail + floating panel chrome (immersive) ─────────
const V4 = ({ collapsed, tab, setTab }) => (
  <div className="wf">
    <TopBar/>
    <div className={"wf-shell " + (collapsed ? "wide-rail" : "wide-open")}>
      <Rail active={tab} onPick={setTab} variant="wide"/>
      {!collapsed && <Drawer tab={tab}/>}
      <div className="wf-work cozy layout-a">
        <Panel title="front_cam" kind="video" chrome="float" selected>
          <VideoStub/>
        </Panel>
        <Panel title="lidar" kind="3d" chrome="float">
          <SceneStub/>
        </Panel>
        <Panel title="ego.speed" kind="plot" chrome="float">
          <PlotStub color="var(--plot-1)" label="ego.speed"/>
        </Panel>
      </div>
    </div>
    <Transport/>
  </div>
);

Object.assign(window, { V1, V2, V3, V4 });
