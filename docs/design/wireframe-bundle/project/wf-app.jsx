// wf-app.jsx — wires V1 into a DesignCanvas with Tweaks.

const { DesignCanvas, DCSection, DCArtboard } = window;
const { TweaksPanel, useTweaks, TweakSection, TweakToggle, TweakRadio } = window;
const { V1 } = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "sidebarCollapsed": false,
  "activeTab": "sources"
}/*EDITMODE-END*/;

const ARTBOARD_W = 1200;
const ARTBOARD_H = 760;

function Intro() {
  return (
    <div className="wf-intro">
      <h1>Driveline · shell wireframes</h1>
      <p>
        App shell: decorative top bar, VS Code-style icon rail with expandable drawer,
        configurable panels with title-bar icons (settings, collapse, fullscreen, close), and a sticky
        transport at the bottom. Toggle the sidebar collapsed/expanded from the Tweaks panel.
      </p>
      <div className="pill-row">
        <span>low-fi</span><span>dark theme</span><span>1200×760</span>
      </div>
    </div>
  );
}

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const collapsed = !!tweaks.sidebarCollapsed;
  const tab = tweaks.activeTab || "sources";
  const setTab = (id) => setTweak("activeTab", id);

  return (
    <React.Fragment>
      <Intro/>
      <DesignCanvas>
        <DCSection id="shells" title="App shell" subtitle="VS Code-style rail · always-visible chrome · sticky transport">
          <DCArtboard id="v1" label="V1 · Standard rail" width={ARTBOARD_W} height={ARTBOARD_H}>
            <V1 collapsed={collapsed} tab={tab} setTab={setTab}/>
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Sidebar">
          <TweakToggle
            label="Collapsed"
            value={collapsed}
            onChange={v => setTweak("sidebarCollapsed", v)}
          />
          <TweakRadio
            label="Active tab"
            value={tab}
            options={[
              { value: "sources",  label: "Sources"  },
              { value: "channels", label: "Channels" },
              { value: "layout",   label: "Layout"   },
              { value: "panel",    label: "Panel"    },
              { value: "events",   label: "Events"   },
            ]}
            onChange={v => setTweak("activeTab", v)}
          />
        </TweakSection>
      </TweaksPanel>
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
