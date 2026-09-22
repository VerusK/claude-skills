.PHONY: install uninstall sync repatch cleanup test deps

deps:
	npm install --no-audit --no-fund

install: deps
	node scripts/install.mjs

uninstall:
	node scripts/install.mjs --uninstall

sync: deps
	node scripts/sync.mjs

repatch:
	node scripts/sync.mjs --repatch

cleanup:
	bash scripts/cleanup.sh

test: deps
	node --test tests/*.test.mjs
