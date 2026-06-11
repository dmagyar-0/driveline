# Driveline demo assets (orphan branch)

Served via raw.githubusercontent.com (CORS: *) to the in-app "Try the demo"
button — see apps/web/src/demo/ on main. NOT part of the source tree; this
orphan branch only carries demo media.

One 60 s segment of California highway driving (CA-280, drive
2018-07-27--06-03-57, segment 10) from the comma2k19 dataset by comma.ai
(https://github.com/commaai/comma2k19, MIT license).

- comma2k19_seg10.mp4            dashcam, 1200 frames @ 20 fps, HEVC -> H.264
- comma2k19_seg10.mp4.timestamps per-frame ns sidecar (segment-start anchored)
- comma2k19.mcap                 CAN speed/steering/wheels, IMU, GNSS (foxglove schemas)
- comma2k19.mf4                  wheel speeds, IMU, GNSS lat/lon/alt as MDF4 scalars

Regenerate: scripts/convert_comma2k19_to_mcap.py / _to_mf4.py (see
sample-data/realworld/README.md on main).
