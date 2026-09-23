.PHONY: install uninstall sync repatch vendor-sdk models release cleanup test deps

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

models:
	node scripts/models.mjs

release:
	git diff --quiet HEAD || { echo "release: commit or stash tracked changes first" >&2; exit 1; }
	node scripts/bump-version.mjs $(BUMP)
	npm install --package-lock-only --no-audit --no-fund
	npm test
	git commit -m "chore(release): $$(node -p "require('./package.json').version")" -- package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json
	claude plugin tag .

cleanup:
	bash scripts/cleanup.sh

test: deps
	npm test
