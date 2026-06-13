.PHONY: fixtures fixtures-check arrow-fixtures

fixtures: arrow-fixtures
	python3 sample-data/generate.py
	python3 sample-data/generate_tabular.py
	python3 sample-data/generate_calib_scene.py

# Regenerate the committed Arrow IPC contract fixtures (scalar, bounding box,
# calibration) from the shared in-repo generators in `crates/data-core`. The
# `*_equals_generator` contract tests gate any drift between these bytes and
# the generators the wasm bindings call at runtime.
arrow-fixtures:
	cargo run -p data-core --example gen_fixture

fixtures-check:
	python3 sample-data/generate.py --check
	python3 sample-data/generate_tabular.py --check
	python3 sample-data/generate_calib_scene.py --check
