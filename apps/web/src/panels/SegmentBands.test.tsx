// @vitest-environment jsdom
//
// Unit tests for the segment-band overlay (iter2 issue #4) and the
// shared `formatSegmentTime` helper. The component is pure so a
// straightforward render → assert flow works.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SegmentBands, formatSegmentTime } from "./SegmentBands";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => cleanup());

describe("formatSegmentTime", () => {
  it("formats positive offsets as mm:ss.SSS", () => {
    const origin = 1_000_000_000n; // 1s in ns
    const stamp = origin + 90_500_000_000n; // +90.5s
    expect(formatSegmentTime(stamp, origin)).toBe("01:30.500");
  });

  it("prefixes negative offsets with `-`", () => {
    const origin = 10_000_000_000n;
    const stamp = origin - 1_500_000_000n;
    expect(formatSegmentTime(stamp, origin)).toBe("-00:01.500");
  });

  it("returns 00:00.000 for the origin itself", () => {
    expect(formatSegmentTime(42n, 42n)).toBe("00:00.000");
  });
});

describe("<SegmentBands />", () => {
  it("renders nothing when bands is empty", () => {
    const { queryByTestId } = render(
      <SegmentBands
        bands={[]}
        bboxLeftPx={0}
        bboxTopPx={0}
        bboxWidthPx={400}
        bboxHeightPx={200}
      />,
    );
    expect(queryByTestId("plot-segment-bands")).toBeNull();
  });

  it("renders one element per band with label when wide enough", () => {
    const { getByTestId, getAllByText } = render(
      <SegmentBands
        bands={[
          {
            id: "s1",
            label: "S1",
            leftFrac: 0,
            widthFrac: 0.5,
            title: "Segment 1",
          },
          {
            id: "s2",
            label: "S2",
            leftFrac: 0.5,
            widthFrac: 0.5,
            title: "Segment 2",
          },
        ]}
        bboxLeftPx={0}
        bboxTopPx={0}
        bboxWidthPx={400}
        bboxHeightPx={200}
      />,
    );
    expect(getByTestId("plot-segment-bands")).toBeTruthy();
    expect(getByTestId("segment-band-s1")).toBeTruthy();
    expect(getByTestId("segment-band-s2")).toBeTruthy();
    expect(getAllByText(/^S[12]$/)).toHaveLength(2);
  });

  it("omits the label when the band is too narrow to read", () => {
    // 1% of 400 px = 4 px, below the 24 px label threshold.
    const { getByTestId, queryByText } = render(
      <SegmentBands
        bands={[
          {
            id: "tiny",
            label: "X",
            leftFrac: 0,
            widthFrac: 0.01,
            title: "Tiny segment",
          },
        ]}
        bboxLeftPx={0}
        bboxTopPx={0}
        bboxWidthPx={400}
        bboxHeightPx={200}
      />,
    );
    expect(getByTestId("segment-band-tiny")).toBeTruthy();
    expect(queryByText("X")).toBeNull();
  });

  it("renders nothing when the bbox is degenerate", () => {
    const { queryByTestId } = render(
      <SegmentBands
        bands={[
          {
            id: "s1",
            label: "S1",
            leftFrac: 0,
            widthFrac: 1,
            title: "Segment 1",
          },
        ]}
        bboxLeftPx={0}
        bboxTopPx={0}
        bboxWidthPx={0}
        bboxHeightPx={0}
      />,
    );
    expect(queryByTestId("plot-segment-bands")).toBeNull();
  });
});
