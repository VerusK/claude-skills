.PHONY: install uninstall sync repatch vendor-sdk cleanup test deps

deps:
	npm install --no-audit --no-fund

install: deps
	node scripts/install.mjs $(ARGS)

uninstall:
	node scripts/install.mjs --uninstall

sync: deps
	node scripts/sync.mjs

repatch:
	node scripts/sync.mjs --repatch

vendor-sdk:
	node scripts/vendor-sdk.mjs

cleanup:
	bash scripts/cleanup.sh

test: deps
	npm test
