.PHONY: fixtures fixtures-check

fixtures:
	python3 sample-data/generate.py

fixtures-check:
	python3 sample-data/generate.py --check
