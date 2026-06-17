import { describe, expect, it } from "vitest";
import { pickOverlayCamera, pickOverlayPointCloud } from "./overlayDefaults";
import type { CameraCalibration } from "./calibrationFromArrow";

// Minimal camera factory — only `name` matters for the picker.
function cam(name: string): CameraCalibration {
  return {
    name,
    model: "ftheta",
    intrinsics: { fx: 1, fy: 1, cx: 1, cy: 1, width: 1920, height: 1080 },
    distortion: [],
    forwardPoly: [0, 1],
    translation: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
  };
}

// The seven cameras an Alpamayo bundle's calibration.calib.json carries, in
// file order. `camera_cross_left_120fov` is first — the old "[0]" default.
const ALPAMAYO = [
  "camera_cross_left_120fov",
  "camera_cross_right_120fov",
  "camera_front_tele_30fov",
  "camera_front_wide_120fov",
  "camera_rear_left_70fov",
  "camera_rear_right_70fov",
  "camera_rear_tele_30fov",
].map(cam);

describe("pickOverlayCamera", () => {
  it("matches the Alpamayo camera whose name equals the video filename stem", () => {
    // The panel shows camera_front_wide_120fov.mp4 — the overlay must bind that
    // camera's calibration, NOT the first one in the list.
    expect(
      pickOverlayCamera(ALPAMAYO, "camera_front_wide_120fov.mp4"),
    ).toBe("camera_front_wide_120fov");
    expect(
      pickOverlayCamera(ALPAMAYO, "camera_rear_tele_30fov.mp4"),
    ).toBe("camera_rear_tele_30fov");
  });

  it("is case-insensitive and tolerant of the extension", () => {
    expect(
      pickOverlayCamera(ALPAMAYO, "Camera_Front_Tele_30fov.MP4"),
    ).toBe("camera_front_tele_30fov");
  });

  it("falls back to the first camera for a single-camera source", () => {
    // Synthetic/nuScenes fixtures: name needn't align, one camera only.
    const one = [cam("CAM_FRONT")];
    expect(pickOverlayCamera(one, "scene_cam_front.mp4")).toBe("CAM_FRONT");
    expect(pickOverlayCamera(one, "anything.mp4")).toBe("CAM_FRONT");
  });

  it("matches when one name is a substring of the other", () => {
    expect(pickOverlayCamera([cam("CAM_FRONT")], "scene_cam_front.mp4")).toBe(
      "CAM_FRONT",
    );
  });

  it("falls back to the first camera when nothing matches the filename", () => {
    expect(pickOverlayCamera(ALPAMAYO, "unrelated_clip.mp4")).toBe(
      "camera_cross_left_120fov",
    );
  });

  it("returns undefined only when there are no cameras", () => {
    expect(pickOverlayCamera([], "camera_front_wide_120fov.mp4")).toBeUndefined();
  });

  it("falls back to the first camera when no filename is known", () => {
    expect(pickOverlayCamera(ALPAMAYO, null)).toBe("camera_cross_left_120fov");
  });
});

describe("pickOverlayPointCloud", () => {
  it("prefers a LiDAR cloud over a radar cloud regardless of order", () => {
    const chans = [
      { id: "r", name: "radar_fused" },
      { id: "l", name: "lidar_top_360fov" },
    ];
    expect(pickOverlayPointCloud(chans)).toBe("l");
    // Order-independent: lidar first still wins.
    expect(pickOverlayPointCloud([chans[1], chans[0]])).toBe("l");
  });

  it("falls back to the first channel when none is a LiDAR", () => {
    expect(
      pickOverlayPointCloud([
        { id: "r", name: "radar_fused" },
        { id: "x", name: "something_else" },
      ]),
    ).toBe("r");
  });

  it("returns undefined for an empty list", () => {
    expect(pickOverlayPointCloud([])).toBeUndefined();
  });
});
