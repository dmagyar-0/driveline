.PHONY: fixtures fixtures-check

fixtures:
	python3 sample-data/generate.py
	python3 sample-data/generate_tabular.py

fixtures-check:
	python3 sample-data/generate.py --check
	python3 sample-data/generate_tabular.py --check
