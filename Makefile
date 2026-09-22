.PHONY: install uninstall sync repatch vendor-sdk release cleanup test deps

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

release:
	node scripts/bump-version.mjs $(BUMP)
	npm install --package-lock-only --no-audit --no-fund
	npm test
	git commit -am "chore(release): $$(node -p "require('./package.json').version")"
	claude plugin tag .

cleanup:
	bash scripts/cleanup.sh

test: deps
	npm test
