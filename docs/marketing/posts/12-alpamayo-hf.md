# Alpamayo (NVIDIA PhysicalAI-Autonomous-Vehicles) — Hugging Face community tab

- **Where:** https://huggingface.co/datasets/nvidia/PhysicalAI-Autonomous-Vehicles
  → Community / Discussions. Secondary: NVIDIA Developer Forums (DRIVE/AV).
- **When:** any weekday
- **Format:** a **format/interest question**, not a showcase — Driveline reads
  MCAP/MF4 and does **not** read Alpamayo's MP4 + Draco-Parquet layout yet.
- **🚫 Licence (critical):** proprietary `nvidia-av-dataset` EULA — **no derivative
  works, no redistribution/hosting of the data in whole or part, 12-month expiry**,
  scoped to internal AV development. **Do NOT attach any Alpamayo frame** to the
  post or README. Demo with your own footage. Ask NVIDIA (in the thread) before
  publishing any sample frame.
- **Risk:** Low–Medium (formal, NVIDIA-run community).

---

**Title:** Open-source browser viewer (Driveline) — could it read the PhysicalAI-AV MP4 + Draco-Parquet layout?

Hi — I maintain **Driveline**, an open-source (MPL-2.0), client-side browser viewer
for multimodal driving logs. It currently reads **MCAP** and **ASAM MF4**, syncing
camera video to high-rate signals on one nanosecond clock, and it's agent-drivable.

I'd like to support this dataset's layout (7× MP4 1080p + LiDAR/radar in
Draco-compressed Parquet) so people can scrub it in a browser. Two questions before
I start:

1. Is there appetite for a browser viewer for this dataset?
2. Per the dataset licence, am I permitted to publish a small sample
   screenshot/clip when documenting viewer support, or should demos use only my own
   footage? I want to respect the EULA's redistribution terms.

Repo: https://github.com/dmagyar-0/driveline. Happy to contribute a loader if it's
welcome.

---

**Pre-post checklist**
- [ ] **Zero Alpamayo frames attached** anywhere
- [ ] Framed as format/interest question (not "it works")
- [ ] Explicitly asks permission re: sample-frame screenshots
- [ ] Posted on the HF community tab (or NVIDIA dev forum)
