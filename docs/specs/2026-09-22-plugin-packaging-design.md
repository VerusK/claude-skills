# Дизайн: упаковка дистро в плагин `verus-skills`

Дата: 2026-09-22. Статус: согласован в kickoff.

## 1. Цель

Раздавать дистро как плагин Claude Code и Codex, не теряя нынешний путь разработки:

- после `claude plugin marketplace add VerusK/claude-skills` и `claude plugin install verus-skills@verus-skills` все 10 скиллов видны;
- SessionStart-хук плагина инжектит `USING.md` в каждую сессию;
- `scripts/typesafe-judge.mjs` и `scripts/reviewer.sh` находятся из плагинного кэша, то есть судья и внешний ревьюер работают, а не деградируют молча;
- `/kickoff` на тестовой задаче доходит до первого вопроса;
- обновления приезжают штатным механизмом обновления плагинов;
- симлинковая установка (`make install`) остаётся альтернативой для разработки.

## 2. Не входит

- Переименование репозитория, `package.json` и внутренних маркеров (`HOOK_MARKER`, `<!-- claude-skills-using -->`): переименовывается только дистрибуция — маркетплейс, плагин и namespace. См. решение 14.
- Публикация в `anthropics/claude-plugins-official` или любой чужой маркетплейс.
- Windows-поддержка (polyglot-обёртка для хуков, как у superpowers).
- Изменение содержательной логики скиллов, судьи и ревьюера: меняются только способ их нахождения и тексты hand-off'ов.
- MCP-серверы, агенты и slash-команды в плагине — плагин состоит из скиллов и одного хука.

## 3. Установленные факты

Проверено на этой машине; дизайн опирается на них.

- Изнутри активного скилла `CLAUDE_SKILL_DIR`, `CLAUDE_PLUGIN_ROOT` и `CLAUDE_PROJECT_DIR` **не выставлены** в окружении Bash-инструмента. Нынешний локатор работает только за счёт ветки `$HOME/.claude/skills/<name>`, которой при плагинной установке нет.
- `CLAUDE_PLUGIN_ROOT` доступен процессам хуков и как подстановка `${...}` в манифестах плагина.
- Self-hosted маркетплейс с `"source": "./"` — рабочая схема (`claude-hud`, `ralphex`).
- Codex подключает те же маркетплейсы через `[marketplaces.<name>]` с `source_type = "git" | "local"`, ставит плагины в `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, поддерживает событие `SessionStart`, формат `hookSpecificOutput.additionalContext` и выставляет `CLAUDE_PLUGIN_ROOT`.
- В кэше плагинов `node_modules` не создаётся.
- CLI даёт `claude plugin validate <path>` с `--strict` и `--json`, `claude plugin tag` (тег `{name}--v{version}` с проверкой согласия `plugin.json` и записи маркетплейса) и `claude plugin marketplace add --sparse`.
- `@typesafe-ai/sdk@0.6.0`: MIT, 204 КБ распакованным, 9 файлов, ноль транзитивных зависимостей. `yaml` нужен только `scripts/sync.mjs`, который из плагина не запускается.

## 4. Дизайн

### 4.1 Архитектура

Репозиторий становится тремя вещами одновременно, без шага сборки:

- **маркетплейс** — `.claude-plugin/marketplace.json`, `name: verus-skills`, единственная запись плагина с `"source": "./"`;
- **плагин** — `.claude-plugin/plugin.json` (Claude Code) и `.codex-plugin/plugin.json` со `"skills": "./skills/"` (Codex), оба с именем `verus-skills`;
- **хук-пакет** — `hooks/hooks.json`, событие `SessionStart`, matcher `startup|clear|compact`, команда `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"`.

В кэш едет весь репозиторий (решение 9): `vendor/`, `patches/`, `tests/` и `docs/` — текст, около мегабайта, и ничего не нужно держать синхронным с урезанной копией.

Установка для Claude Code:

```bash
claude plugin marketplace add VerusK/claude-skills   # или локальный путь к чекауту
claude plugin install verus-skills@verus-skills
```

Для Codex — те же секции в `~/.codex/config.toml`:

```toml
[marketplaces.verus-skills]
source_type = "git"
source = "https://github.com/VerusK/claude-skills.git"

[plugins."verus-skills@verus-skills"]
enabled = true
```

Симлинковая установка остаётся путём разработки и **отказывается работать**, когда плагин уже установлен; обход — `--force` (решение 3).

### 4.2 Компоненты

| Файл | Изменение |
|---|---|
| `.claude-plugin/plugin.json` | новый: `name: verus-skills`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords` |
| `.claude-plugin/marketplace.json` | новый: `name: verus-skills`, `owner`, одна запись плагина с `"source": "./"` и той же `version` |
| `.codex-plugin/plugin.json` | новый: те же поля + `"skills": "./skills/"` и блок `hooks` |
| `hooks/hooks.json` | новый: `SessionStart` → `node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"` |
| `scripts/session-start.mjs` | резолвит корень из собственного пути, пишет pointer-файл `~/.verus-skills/root`, инжектит `USING.md` и строку `Distro root: <path>` |
| `vendor-node/@typesafe-ai/sdk/` | новый: вендоренная копия SDK |
| `scripts/vendor-sdk.mjs` | новый: `npm pack @typesafe-ai/sdk@<версия из package.json>` → распаковка в `vendor-node/` |
| `scripts/typesafe-judge.mjs` | `import("@typesafe-ai/sdk")`, при неудаче — импорт по file-URL из `vendor-node/` |
| `skills/kickoff/judge.md`, `skills/plan-review/SKILL.md`, `skills/review/SKILL.md` | локатор: сначала pointer-файл, затем нынешние ветки |
| `scripts/install.mjs` | детект установленного плагина → отказ с подсказкой; флаг `--force` |
| `scripts/bump-version.mjs`, `Makefile` | синхронный bump версии в четырёх файлах, цель `make release` (bump + `claude plugin tag`) |
| hand-off'ы в 8 местах + `USING.md` | имя скилла и его плагинная форма: ``invoke the `review` skill (`verus-skills:review` when installed as a plugin)`` |
| `tests/plugin.test.mjs` | новый |
| `README.md`, `CLAUDE.md` | два способа установки, релизный цикл, ручное снятие плагина `superpowers` |

Семь скиллов из `skills/` — патченые копии upstream; правки их текста делаются в `skills/`, после чего обязателен `make repatch`.

### 4.3 Поток данных

```
SessionStart
  → хук плагина (в его окружении есть CLAUDE_PLUGIN_ROOT)
  → scripts/session-start.mjs: ROOT = dirname(самого себя)/..
      ├─ пишет ROOT в ~/.verus-skills/root
      └─ печатает additionalContext: USING.md + "Distro root: <ROOT>"

скилл, shell-блок
  → SKILLS_REPO=$(cat ~/.verus-skills/root)        # если в нём есть scripts/typesafe-judge.mjs
  → иначе $HOME/.claude/skills/<name>              # симлинковая установка, как сейчас
  → иначе $HOME/.codex/skills/<name>
  → node "$SKILLS_REPO/scripts/typesafe-judge.mjs" | bash "$SKILLS_REPO/scripts/reviewer.sh"

судья
  → import("@typesafe-ai/sdk")                     # чекаут разработчика с node_modules
  → catch → import("file://$ROOT/vendor-node/@typesafe-ai/sdk/<entry из его package.json>")
```

Один и тот же `session-start.mjs` обслуживает обе установки: при симлинковой его в `~/.claude/settings.json` прописывает `install.mjs`, при плагинной — `hooks/hooks.json`; корень в обоих случаях вычисляется от пути самого скрипта, а не от переменной окружения.

### 4.4 Обработка ошибок

| Ситуация | Поведение |
|---|---|
| pointer-файла нет или он указывает в никуда | кандидат отбрасывается по отсутствию `scripts/typesafe-judge.mjs`, локатор идёт дальше по веткам симлинков |
| ни одна ветка не сработала | нынешнее сообщение `judge not found` / `reviewer not found`; `judge_exit ≠ 0` → скилл спрашивает пользователя, `reviewer_exit = 127` → трактуется как `1`, скилл не продолжает |
| SDK не импортировался ни из `node_modules`, ни из `vendor-node/` | `exit 2`, как сейчас: скилл спрашивает пользователя и пишет строку `TypeSafe judge unavailable: <stderr>` |
| хук не отработал (resume, чужой хост, Codex без плагина) | остаются ветки симлинков; если и их нет — предыдущая строка |
| установлены и плагин, и симлинки | `install.mjs` отказывается и объясняет; README описывает, как выбрать одно |
| `claude` недоступен (CI) | тест валидации манифестов пропускается, чистые JS-проверки работают всегда |
| вендоренный SDK разошёлся с `package-lock.json` | красный тест, а не молчаливая деградация в рантайме |

## 5. Тестирование

Новый `tests/plugin.test.mjs` в стиле сюиты (`node:test`, `node:assert/strict`, временные каталоги, очистка в `after()`, стабы из `tests/fixtures/fake-bin`):

1. все 10 каталогов из `skills/` присутствуют и содержат `SKILL.md`;
2. версия совпадает в `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` и записи маркетплейса;
3. команда хука после подстановки `${CLAUDE_PLUGIN_ROOT}` указывает на существующий файл;
4. `vendor-node/@typesafe-ai/sdk` есть, его версия равна resolved-версии из `package-lock.json`;
5. `session-start.mjs` с подставными `HOME` и `CLAUDE_PLUGIN_ROOT` пишет pointer-файл и печатает валидный JSON с содержимым `USING.md`;
6. локаторный сниппет одинаков во всех трёх скиллах и в подставном `HOME` резолвит корень из pointer-файла;
7. судья импортирует SDK из `vendor-node/`, когда `node_modules` не виден;
8. `install.mjs` отказывается, когда стаб `claude plugin list` показывает `verus-skills@verus-skills`, и ставит при `--force`;
9. при наличии бинаря `claude` — `claude plugin validate . --strict --json`, иначе `skip`.

Ручная приёмка после реализации: `claude plugin marketplace add <локальный путь>` → `claude plugin install verus-skills@verus-skills` → новая сессия → в контексте есть блок `USING.md` → `/kickoff` на тестовой задаче доходит до первого вопроса → судья отвечает `judge_exit=0` → `reviewer.sh` находится.

## 6. Открытые вопросы, уходящие в план как задачи с проверкой

- Точный формат блока `hooks` в `.codex-plugin/plugin.json`: у superpowers это `{}` при отдельном `hooks/hooks.json`, у бандлов OpenAI — inline `hooks.hooks`. Проверяется установкой в Codex.
- Резолвит ли Skill tool голое имя скилла внутри плагина. Обходится дублированием имени в hand-off'ах (решение 5), но стоит проверить фактически.
- Как зовётся slash-команда: `/kickoff` или `/verus-skills:kickoff`. Проверяется на приёмке.

## 7. Решения

### 1. Где живёт манифест маркетплейса — `auto`

```
Решение (Jev): Where should the plugin marketplace manifest for the claude-skills distro live?
  A. Self-hosted in the same repo  100%
  B. A separate marketplace repo   0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 2. Как плагин получает `@typesafe-ai/sdk` — `auto`

```
Решение (Jev): How should the claude-skills plugin make the @typesafe-ai/sdk npm package available to scripts/typesafe-judge.mjs when the skills run from the plugin cache?
  A. Vendor the SDK into the repo              100%
  B. Lazy npm install into the plugin cache    0%
  C. Drop the SDK, call the HTTP API directly  0%
  D. Tell the user to run npm install          0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 3. Сосуществование симлинковой установки и плагина — `auto`

```
Решение (Jev): When the plugin is installed, what should the existing symlink installer (scripts/install.mjs) do about the two installations coexisting?
  A. Detect and refuse with a hint       100%
  B. Uninstall the plugin automatically  0%
  C. Do nothing, document it             0%
  D. Warn but continue                   0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 4. Как скилл находит корень дистро — `auto`

```
Решение (Jev): How should a skill running from the plugin cache locate the distro root, so that scripts/typesafe-judge.mjs and scripts/reviewer.sh can be invoked from a plain Bash call?
  A. Extend the inline locator with cache globs     0%
  B. SessionStart hook writes a pointer file        100%
  C. Inject the root into the session context only  0%
  D. Read installed_plugins.json with node          0%
  Выбрано: B, confidence 1.00, порог 0.7 → принято автоматически
```

### 5. Namespace в hand-off'ах — `auto`

```
Решение (Jev): How should the skills name each other in their hand-offs, given that plugin-installed skills are addressed as claude-skills:<name> while symlinked ones are addressed by the bare name?
  A. Name both forms in every hand-off      99%
  B. Bare names plus one rule in USING.md   1%
  C. Switch to namespaced names everywhere  0%
  Выбрано: A, confidence 0.98, порог 0.7 → принято автоматически
```

Префикс из блока — `claude-skills:` — заменён на `verus-skills:` решением 14.

### 6. Дистрибуция для Codex — `auto`

```
Решение (Jev): Should Codex keep being served by the symlink installer, or should it also consume the distro as a plugin?
  A. Ship a Codex plugin manifest too  100%
  B. Claude Code plugin only           0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 7. Где лежит вендоренный SDK — `auto`

```
Решение (Jev): Where in the repo should the vendored @typesafe-ai/sdk live, and how should scripts/typesafe-judge.mjs resolve it?
  A. vendor-node/ plus an explicit fallback import  100%
  B. Commit node_modules/@typesafe-ai/sdk           0%
  C. Vendor the source into scripts/                0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 8. Где лежит pointer-файл — `auto`

```
Решение (Jev): Where should the SessionStart hook write the distro-root pointer file that the skills' shell blocks read?
  A. ~/.claude-skills/root                                                    99%
  B. Per-agent: ~/.claude/claude-skills-root and ~/.codex/claude-skills-root  0%
  C. XDG state dir: ${XDG_STATE_HOME:-~/.local/state}/claude-skills/root      1%
  Выбрано: A, confidence 0.98, порог 0.7 → принято автоматически
```

Принят вариант «собственный каталог в `$HOME`»; конкретный путь переименован в `~/.verus-skills/root` решением 14.

### 9. Что едет в кэш плагина — `auto`

```
Решение (Jev): What should the plugin's payload be — the whole repository, or a trimmed subset?
  A. The whole repo as the plugin      100%
  B. Trim with git sparse-checkout     0%
  C. A dedicated plugin/ subdirectory  0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 10. Версионирование — `auto`

```
Решение (Jev): How should plugin versions be managed so that `claude plugin update` delivers new work?
  A. Track HEAD of main, no version bumps          0%
  B. Semver in both manifests, bumped by a script  100%
  C. Semver bumped by hand                         0%
  Выбрано: B, confidence 1.00, порог 0.7 → принято автоматически
```

### 11. Покрытие упаковки тестами — `auto`

```
Решение (Jev): How should the plugin packaging be covered by the test suite?
  A. Pure node tests plus an opt-in CLI check  100%
  B. Pure node tests only                      0%
  C. CLI validation only                       0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 12. Как вендорится SDK — `auto`

```
Решение (Jev): How should the vendored copy of @typesafe-ai/sdk under vendor-node/ be produced and kept in step with package.json?
  A. A script plus a test that asserts agreement  100%
  B. Copy from node_modules after npm install     0%
  C. Vendor by hand, document the steps           0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 13. Чем реализован хук — `auto`

```
Решение (Jev): What should the plugin's SessionStart hook command be?
  A. Reuse the existing node script                100%
  B. A bash hook script like the reference plugin  0%
  Выбрано: A, confidence 1.00, порог 0.7 → принято автоматически
```

### 14. Объём переименования в `verus-skills` — `user`

Вопрос: какой объём переименования в `verus-skills`?

- A. Полное: репо, пакет, плагин, маркеры — одно имя везде, но самый большой diff и ручное переименование репо на GitHub.
- B. Только дистрибуция: маркетплейс, плагин, namespace, pointer-файл — меньше правок, но имя репо и имя плагина расходятся.
- C. Оставить `claude-skills`.

Выбрано пользователем: **B**. Маркетплейс и плагин зовутся `verus-skills`, скиллы адресуются `verus-skills:<name>`, pointer-файл — `~/.verus-skills/root`. Репозиторий `VerusK/claude-skills`, `package.json`, `HOOK_MARKER` и маркер `<!-- claude-skills-using -->` не меняются, миграционный код не нужен.
