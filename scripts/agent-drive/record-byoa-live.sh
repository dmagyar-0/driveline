#!/usr/bin/env bash
#
# Reproduce the committed live agent-driven BYOA clip (demo/byoa-agent-live.webm).
#
# The original clip was recorded by an agent (Claude Code) driving the
# production window.__drivelineAgent surface live through the harness in
# scripts/agent-drive/live-driver.mjs. This script REPLAYS the exact call
# sequence that agent issued, so a human can regenerate the same video
# end-to-end with one command. The decisions baked in here are the real
# ones the agent made from data it read back during recording:
#   - 4973 rows of real comma2k19 CAN: no hard braking (worst 0.8s decel
#     only -0.66 m/s^2) -> a steady ~31 m/s highway cruise;
#   - the one notable maneuver is the peak steering input, -11.7 deg @ 28.3s.
# Both are tagged as agent events (origin:"agent" + confidence), and the
# on-screen "agent HUD" narrates every call so the clip is self-evidently
# agent-driven.
#
# Usage:  scripts/agent-drive/record-byoa-live.sh
# Output: demo/byoa-agent-live.webm      (tight cut, dead air removed)
#         demo/byoa-agent-live-raw.webm  (full live recording)
#
# Prereqs: pnpm install, pnpm wasm:build (or :dev), Playwright chromium
# (scripts/setup-test-env.sh), ffmpeg, and the comma2k19 fixtures present
# under sample-data/realworld/ (see sample-data/realworld/README.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${BASE:-http://localhost:5173}"
Q="${AGENT_Q:-/tmp/agentq-live}"
REC="${AGENT_REC:-/tmp/agentrec-live}"
N=0

# --- dev server (reuse if already up) ---------------------------------------
if ! curl -sf -o /dev/null -m 3 "$BASE"; then
  echo "[repro] starting web dev server..."
  ( cd "$ROOT" && pnpm --filter web dev >/tmp/byoa-live-vite.log 2>&1 ) &
  curl -s --retry-connrefused --retry 90 --retry-delay 1 -o /dev/null "$BASE"
fi
echo "[repro] dev server: $BASE"

# --- queue + results FIFO ---------------------------------------------------
rm -rf "$Q" "$REC"; mkdir -p "$Q/done" "$REC"; mkfifo "$Q/results"

# live-driver.mjs anchors its Playwright require at apps/e2e by absolute path,
# so it can be launched from anywhere.
echo "[repro] launching live driver (recorded browser)..."
AGENT_Q="$Q" AGENT_REC="$REC" node "$ROOT/scripts/agent-drive/live-driver.mjs" \
  >/tmp/byoa-live-driver.log 2>&1 &
DRIVER_PID=$!

# Block on the FIFO until the browser has booted + HUD is installed.
cat "$Q/results" >/dev/null
echo "[repro] driver ready; replaying agent commands..."

# send: read a JS expression body on stdin, hand it to the driver, print result.
send() {
  N=$((N + 1))
  cat > "$Q/.tmp"
  mv "$Q/.tmp" "$Q/cmd-$N.js"
  echo "  cmd-$N -> $(cat "$Q/results")"
}

send <<'JS'
(async () => {
  const a = window.__drivelineAgent, h = window.__drivelineDevHooks;
  window.__agentLog('<b>Bring Your Own Agent — real comma2k19 dashcam</b>','info');
  window.__agentLog('&rarr; getSkill() &middot; describe()  <span style=opacity:.7>(discovering the surface)</span>','call');
  const skill=a.getSkill(), m=a.describe();
  window.__agentLog('read the BYOA skill ('+skill.length+' chars) &middot; '+m.capabilities.length+' capabilities &middot; API v'+a.version,'data');
  h.setLayoutJson({ global:{tabEnableClose:true,tabEnableRename:false,splitterSize:4,borderEnableAutoHide:true}, borders:[],
    layout:{type:'row',weight:100,children:[
      {type:'tabset',weight:50,children:[{type:'tab',id:'video-1',name:'Dashcam',component:'video'}]},
      {type:'tabset',weight:50,children:[{type:'tab',id:'plot-1',name:'Speed (m/s)',component:'plot'}]}]}});
  document.querySelector('[data-testid="rail-events"]')?.click();
  await new Promise(r=>setTimeout(r,1600));
  return { version:a.version, caps:m.capabilities.length };
})()
JS

send <<'JS'
(async () => {
  const h = window.__drivelineDevHooks;
  window.__agentLog('&rarr; loading comma2k19 dashcam (mp4+sidecar) + CAN signals (mcap)','call');
  const rels=['realworld/comma2k19.mcap','realworld/comma2k19_seg10.mp4','realworld/comma2k19_seg10.mp4.timestamps'];
  const descs=await Promise.all(rels.map(async rel=>{ const r=await fetch('/sample-data/'+rel);
    return { name:rel.split('/').pop(), bytes:new Uint8Array(await r.arrayBuffer()) }; }));
  const res=await h.openFiles(descs);
  window.__agentLog('opened: '+res.opened.join(', ')+(res.errors.length?(' · errors:'+res.errors.length):''),'ok');
  await new Promise(r=>setTimeout(r,1200));
  return res;
})()
JS

send <<'JS'
(async () => {
  const a = window.__drivelineAgent, h = window.__drivelineDevHooks;
  window.__agentLog('&rarr; bind dashcam + bind /vehicle/speed &rarr; plot','call');
  const vid=h.findChannelId({sourceName:'comma2k19_seg10.mp4', nativeId:'1/video'});
  h.setVideoChannelBinding('video-1', vid);
  const speed=a.listChannels().find(c=>c.name==='/vehicle/speed');
  const bound=a.bindChannels('plot-1',[speed.id]);
  a.setCursor(a.getSessionSnapshot().globalRange.startNs);
  let t=0; while(t<60 && !h.videoLastBlitPtsNs()){ await new Promise(r=>setTimeout(r,200)); t++; }
  window.__agentLog('dashcam decoding · speed plotted (bound:'+bound+')','ok');
  await new Promise(r=>setTimeout(r,2400));
  return { videoBound:!!vid, speedId:speed.id, bound, gotFrame: !!h.videoLastBlitPtsNs() };
})()
JS

send <<'JS'
(async () => {
  const a = window.__drivelineAgent;
  const r=a.getSessionSnapshot().globalRange;
  const chans=a.listChannels();
  window.__agentLog('&rarr; fetchChannelRange + profile  <span style=opacity:.7>(what is actually happening in this drive?)</span>','call');
  const summarise=async(name)=>{ const c=chans.find(x=>x.name===name); if(!c) return null;
    const res=await a.fetchChannelRange(c.id, r.startNs, r.endNs); if(!res) return null;
    const v=res.columns.find(x=>x.name==='value').values.filter(x=>x!=null);
    let mn=Infinity,mx=-Infinity; for(const x of v){ if(x<mn)mn=x; if(x>mx)mx=x; }
    const ts=res.columns.find(x=>x.name==='ts').values; const WIN=800000000n; let worst=0,j=0;
    for(let i=0;i<ts.length;i++){ const tEnd=BigInt(ts[i])+WIN; while(j<ts.length && BigInt(ts[j])<tEnd) j++;
      const k=Math.min(j,ts.length-1); if(k<=i) continue; const dt=Number(BigInt(ts[k])-BigInt(ts[i]))/1e9;
      if(dt>0){ const rate=(v[k]-v[i])/dt; if(rate<worst) worst=rate; } }
    return {name, rows:res.rows, min:+mn.toFixed(2), max:+mx.toFixed(2), worstDecel:+worst.toFixed(2)}; };
  const spd=await summarise('/vehicle/speed');
  const steer=await summarise('/vehicle/steering_angle');
  window.__agentLog('speed '+spd.min+'–'+spd.max+' m/s · hardest decel only '+spd.worstDecel+' m/s² · steering '+steer.min+'–'+steer.max+'°','data');
  await new Promise(r=>setTimeout(r,1800));
  return { spd, steer };
})()
JS

send <<'JS'
(async () => {
  const a = window.__drivelineAgent;
  const r=a.getSessionSnapshot().globalRange;
  const chans=a.listChannels();
  const peak=async(name,mode)=>{ const c=chans.find(x=>x.name===name);
    const res=await a.fetchChannelRange(c.id, r.startNs, r.endNs);
    const ts=res.columns.find(x=>x.name==='ts').values, v=res.columns.find(x=>x.name==='value').values;
    let bi=0,bv=mode==='absmax'?-1:-Infinity;
    for(let i=0;i<v.length;i++){ if(v[i]==null)continue; const m=mode==='absmax'?Math.abs(v[i]):v[i]; if(m>bv){bv=m;bi=i;} }
    return {ns:ts[bi], val:+v[bi].toFixed(2), t:+(Number(BigInt(ts[bi])-BigInt(r.startNs))/1e9).toFixed(1)}; };
  window.__agentLog('&rarr; locating steering extreme + top speed','call');
  const steer=await peak('/vehicle/steering_angle','absmax');
  const spd=await peak('/vehicle/speed','max');
  window.__agentLog('peak steering '+steer.val+'° @ '+steer.t+'s · top speed '+spd.val+' m/s @ '+spd.t+'s','data');
  await new Promise(res=>setTimeout(res,1600));
  return { steer, spd };
})()
JS

send <<'JS'
(async () => {
  const a = window.__drivelineAgent;
  const r=a.getSessionSnapshot().globalRange;
  window.__agentLog('decision: no hard braking found — this is a steady highway cruise','decision');
  const id1=a.addEvent({ ns:r.startNs, label:'Steady highway cruise · 30–33 m/s (~113 km/h)',
    tags:{maneuver:'Go straight', road_type:'Highway', lighting:'Day'}, confidence:0.90 });
  a.setEventRange(id1, '0', String(BigInt(r.endNs)-BigInt(r.startNs)));
  window.__agentLog('decision: peak steering &minus;11.7° @ 28.3s &rarr; <b>gentle curve / lane adjust</b>, conf 0.65','decision');
  const id2=a.addEvent({ ns:'1532671465291291052', label:'Peak steering −11.7° · gentle curve',
    tags:{maneuver:'Lane change', road_type:'Highway'}, confidence:0.65 });
  window.__agentLog('&rarr; addEvent ×2 (1 ranged band + 1 point) · origin:"agent" + confidence','ok');
  await new Promise(res=>setTimeout(res,2400));
  return { id1, id2, count:a.listEvents().length };
})()
JS

send <<'JS'
(async () => {
  const a = window.__drivelineAgent, h = window.__drivelineDevHooks;
  window.__agentLog('&rarr; setCursor &rarr; peak-steering event (28.3s)','call');
  a.setCursor('1532671465291291052');
  let t=0; while(t<40 && !h.videoLastBlitPtsNs()){ await new Promise(r=>setTimeout(r,200)); t++; }
  await new Promise(r=>setTimeout(r,2800));
  window.__agentLog('&rarr; play() through the maneuver','call');
  a.setCursor('1532671462000000000'); a.play();
  await new Promise(r=>setTimeout(r,5500));
  a.pause();
  window.__agentLog('done — agent analysed REAL data, reported honestly, tagged 2 findings','ok');
  await new Promise(r=>setTimeout(r,2200));
  return { done:true };
})()
JS

# --- flush + collect --------------------------------------------------------
N=$((N + 1)); printf '__QUIT__' > "$Q/.tmp"; mv "$Q/.tmp" "$Q/cmd-$N.js"
cat "$Q/results" >/dev/null
wait "$DRIVER_PID"   # driver writes the .webm during context.close(), then exits

RAW="$(ls -t "$REC"/*.webm | head -1)"
echo "[repro] raw recording: $RAW ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW")s)"

mkdir -p "$ROOT/demo"

# Replaying the commands back-to-back leaves no dead air (the only pauses are
# the in-page dwells, which are deliberate and readable), so just compact the
# recording to VP9 — no frame-dropping. (When an agent drives the harness
# *interactively*, its between-turn thinking shows as dead air; trim that case
# with ffmpeg's mpdecimate — see docs/13 "Live agent-driven recording".)
echo "[repro] compacting to VP9..."
ffmpeg -hide_banner -v error -y -i "$RAW" \
  -c:v libvpx-vp9 -b:v 2M -pix_fmt yuv420p -an "$ROOT/demo/byoa-agent-live.webm"

echo "[repro] done:"
echo "  demo/byoa-agent-live.webm ($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$ROOT/demo/byoa-agent-live.webm")s)"
