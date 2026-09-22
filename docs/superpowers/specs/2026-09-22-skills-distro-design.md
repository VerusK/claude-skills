# Дизайн: репо-дистрибутив скиллов с синком из upstream

Дата: 2026-09-22. Статус: согласован в брейнсторме.

## 1. Цель

Превратить `claude-skills` в личный набор скиллов для Claude Code и Codex, который:

- задаёт один сквозной флоу «опрос → спека → план → ревью плана → исполнение → ревью ветки → завершение»;
- берёт готовые скиллы из чужих репо копиями, накладывает свои патчи и регулярно обновляется из upstream;
- сводит вопросы с вариантами ответов к вероятностной оценке через TypeSafe (модель Jev) и принимает ответ сам, когда уверенность выше порога;
- ставится одной командой в Claude Code и Codex, заменяя плагин superpowers, gstack и compound-engineering.

Не входит в первую версию: перенос других наборов (security-audit, mattpocock, ralphex, claude-mem), синк чего-либо кроме перечисленных ниже источников.

## 2. Состав скиллов

Все скиллы лежат в `skills/<name>/SKILL.md`, плоско, потому что Claude Code ищет скиллы на один уровень.

| Скилл | Происхождение | Роль во флоу |
|---|---|---|
| `kickoff` | свой | входная точка: опрос, спека |
| `writing-plans` | obra/superpowers, копия с патчем | план из спеки |
| `plan-review` | свой, промпт из garrytan/gstack `plan-eng-review` | ревью плана внешним голосом |
| `subagent-driven-development` | obra/superpowers, копия с патчем | исполнение плана |
| `branch-review` | свой, промпт из obra/superpowers `requesting-code-review/code-reviewer.md` | финальное ревью ветки |
| `finishing-a-development-branch` | obra/superpowers, копия | merge / PR / оставить |
| `test-driven-development` | obra/superpowers, копия | вне флоу, используется имплементаторами |
| `verification-before-completion` | obra/superpowers, копия | вне флоу |
| `systematic-debugging` | obra/superpowers, копия | вне флоу |
| `typesafe-ai` | typesafe-ai/skills, копия | вне флоу, работа с TypeSafe в проектах |

Удаляется: текущий `code-review/` из репо (чеклисты без привязки к плану, дублирует ревью внутри SDD).

Лицензии всех upstream: MIT. Атрибуция в `NOTICE` и в README.

### 2.1. Флоу

```
kickoff ──► writing-plans ──► plan-review ──► subagent-driven-development ──► branch-review ──► finishing-a-development-branch
   │                              │  ▲                    │                        │
   │ вопросы с вариантами         │  └── 1 повторный круг  │ задачные ревью Claude  │ находки
   ▼                              ▼                        ▼                        ▼
 TypeSafe judge              TypeSafe judge          (внутри SDD)             TypeSafe judge
```

Каждый скилл флоу в конце говорит, какой скилл следующий, и вызывает его. `USING.md` в корне репо описывает маршрутизацию и подключается в сессию хуком (см. §6).

### 2.2. `kickoff`

Объединяет `grilling` (mattpocock) и `brainstorming` (superpowers):

- классификация задачи spike / bounded / architectural, как в brainstorming;
- дерево решений и работа «фронтиром» по раундам, как в grilling; факты ищутся сабагентами, решения задаются пользователю;
- каждый вопрос формулируется с вариантами ответов (2–4) и рекомендацией;
- перед показом пользователю вопрос уходит в TypeSafe judge (§4). Если `confidence >= порог`, ответ принимается автоматически. Иначе вопрос показывается пользователю вместе с вероятностями;
- после каждого автопринятого ответа в чат выводится блок «Решение»: вопрос, варианты с вероятностями, выбранный вариант, confidence;
- на выходе спека в `docs/specs/YYYY-MM-DD-<topic>-design.md` с разделом «Решения», где перечислены все автопринятые ответы в том же формате;
- терминальный шаг: вызов `writing-plans`.

Spike-путь и bounded-путь сохраняются из brainstorming: spike заканчивается рекомендацией, bounded коротким дизайном в чате и переходом сразу к исполнению без плана.

### 2.3. `plan-review` и `branch-review`

Два отдельных скилла с общим лаунчером `scripts/reviewer.sh` (§5). Различаются промптом и входом:

- `plan-review <файл плана>`: промпт `skills/plan-review/reviewer.md`, извлечён из gstack `plan-eng-review`: секции архитектура, качество кода, тесты, производительность, калибровка confidence 1–10, формат находки `[P1] (confidence: 9/10) file:line — описание`. Без преамбулы gstack, без AskUserQuestion, без learnings.
- `branch-review [база]`: промпт `skills/branch-review/reviewer.md` на основе superpowers `code-reviewer.md`: сверка diff с планом и спекой, качество, тесты, готовность к merge. База по умолчанию `main`.

Общая логика обоих:

1. Скилл читает план или собирает diff, вклеивает содержимое в промпт целиком (Codex в песочнице репо не видит файлы вне него).
2. Промпт просит ревьюера записать отчёт в файл: `docs/plans/<имя>.review.md` для плана, `docs/reviews/<ветка>-<дата>.md` для ветки. Буфер терминала не парсится.
3. Запуск через `scripts/reviewer.sh` (§5). Код возврата 3 означает «внешний ревьюер недоступен», тогда скилл запускает Claude-агента (`Agent`, `model: opus`) с тем же промптом.
4. Находки с confidence 7+ превращаются в вопросы с вариантами: принять и внести в план или код, отклонить с обоснованием. Вопросы идут через TypeSafe judge по тем же правилам, что в `kickoff`. Находки ниже 7 попадают в приложение отчёта без действий.
5. После правок один повторный круг: тому же ревьюеру (в Orca в ту же сессию Codex как follow-up, иначе новый `codex exec`). Стоп, когда нет P0/P1 с confidence 7+ или после второго круга.
6. Блок «Решение» выводится в чат и дописывается в план (раздел «Review decisions (round N)»). Файл отчёта ревьюера не редактируется.

### 2.4. Патчи к копиям superpowers

- Все ссылки `superpowers:<name>` заменяются на наши имена (`superpowers:brainstorming` → `kickoff`, `superpowers:requesting-code-review` → `branch-review`).
- Шаг `using-git-worktrees` удаляется из `subagent-driven-development` и `writing-plans`: работа всегда идёт в worktree Orca.
- В `subagent-driven-development` финальный ревьюер заменяется вызовом `branch-review`; задачные ревью после каждой задачи остаются на Claude-сабагентах.
- Во все места, где запускаются сабагенты, добавляется правило `model: opus` (правило пользователя из глобальной памяти).
- Пути `docs/superpowers/specs/` → `docs/specs/`, `docs/superpowers/plans/` → `docs/plans/`.
- Шапка плана в `writing-plans` ссылается на `subagent-driven-development` без префикса и убирает `executing-plans`.

## 3. Структура репо

```
claude-skills/
  README.md                 # описание, таблица источников, схема, установка
  NOTICE                    # атрибуция upstream (MIT)
  USING.md                  # правило маршрутизации по флоу, инжектится в сессию
  Makefile                  # install, uninstall, sync, repatch, cleanup
  sources.yaml              # внешние источники
  sources.lock.json         # SHA коммитов и хеши файлов
  config/judge.json         # порог confidence, модель
  package.json              # @typesafe-ai/sdk, node >= 20
  skills/<name>/            # устанавливаемые скиллы
  vendor/<name>/            # чистые копии upstream
  patches/<name>.patch      # diff vendor → skills
  scripts/
    sync.mjs                # синк по sources.yaml
    install.mjs             # симлинки, хук, AGENTS.md
    cleanup.sh              # удаление gstack / compound-engineering / superpowers
    reviewer.sh             # лаунчер Orca → codex exec
    typesafe-judge.mjs      # вероятностная оценка вариантов
  .github/workflows/sync.yml
  docs/superpowers/specs/   # эта спека и будущие
```

## 4. TypeSafe judge

`scripts/typesafe-judge.mjs`, Node 20+, зависимость `@typesafe-ai/sdk`.

Вход (stdin, JSON):

```json
{
  "question": "Где хранить API key?",
  "options": [
    {"id": "A", "label": "settings.json env", "description": "..."},
    {"id": "B", "label": "~/.zshenv", "description": "..."}
  ],
  "context": "краткий контекст задачи и проекта, до ~4 КБ",
  "recommended": "A"
}
```

Выход (stdout, JSON):

```json
{
  "choice": "A",
  "probabilities": {"A": 0.82, "B": 0.18},
  "confidence": 0.64,
  "threshold": 0.7,
  "accepted": false
}
```

- Вызов SDK: `client.systemOne({ state: { question, context, recommended }, questions: { answer: choice(question, {A: description, B: description}) } })`.
- Ответ SDK v0.6.0 (`ChoiceResponse`): поля `choice`, `confidence` и `probabilities` по меткам. Скрипт пробрасывает их как есть, ничего не пересчитывает.
- `accepted = confidence >= threshold`. Порог из `config/judge.json`, по умолчанию `0.7`, переопределяется флагом `--threshold`.
- Ключ из `TYPESAFE_API_KEY`. Пользователь кладёт его в блок `env` глобального `~/.claude/settings.json`; для Codex в `~/.zshenv`.
- Ошибка сети, отсутствие ключа или пустой ответ: код возврата 2, скилл показывает вопрос пользователю как обычно и пишет, что judge недоступен. Автопринятие без judge запрещено.
- Формат блока «Решение» в чате и документах:

```
Решение (Jev): Где хранить API key?
  A. settings.json env      82%
  B. ~/.zshenv              18%
  Выбрано: A, confidence 0.64, порог 0.7 → спросил пользователя
```

## 5. Лаунчер ревьюера

`scripts/reviewer.sh --prompt-file <f> --output <отчёт> [--session <id>]`. Порядок:

1. **Orca**: `orca status --json` отвечает. Создать терминал `orca terminal create --worktree active --command codex --title <skill> --json`, дождаться `terminal wait --for tui-idle` с `satisfied: true`, отправить промпт через `terminal send --enter --wait-submit 10`, дождаться `tui-idle` с таймаутом 15 мин, проверить, что файл отчёта появился. Handle терминала сохраняется в `.context/<skill>-session` для повторного круга через `terminal send`.
2. **`codex exec`**: если Orca нет или шаг 1 не дал отчёт. `codex exec -C <repo> --enable web_search_cached -c model_reasoning_effort=high` с промптом на stdin, таймаут 10 мин. Повторный круг: новый `codex exec` с предыдущим отчётом в промпте.
3. **Код 3**: ни Orca, ни `codex`, либо auth-ошибка, либо таймаут на обоих. Скилл запускает Claude-агента.

Промпт всегда начинается с границы файловой системы, как в gstack: не читать `~/.codex/`, `~/.agents/`, `.codex/skills/`, `agents/`. Скрипт печатает, какой путь сработал, и это попадает в отчёт.

## 6. Установка

`make install` → `node scripts/install.mjs`:

- симлинки `skills/*` → `~/.claude/skills/<name>` и `~/.codex/skills/<name>`; существующие симлинки на этот репо пересоздаются, чужие не трогаются, о конфликтах имён сообщается;
- в `~/.claude/settings.json` добавляется SessionStart-хук `cat <abs>/USING.md` (идемпотентно, по маркеру в команде); превью изменений перед записью;
- в `~/.codex/AGENTS.md` добавляется строка-ссылка на `<abs>/USING.md` (идемпотентно);
- `claude plugin uninstall superpowers@claude-plugins-official`, если установлен;
- проверка `TYPESAFE_API_KEY`, `codex`, `orca` с выводом, чего не хватает.

`make uninstall` убирает симлинки, хук и строку в AGENTS.md.

`make cleanup` → `scripts/cleanup.sh`: печатает список и просит подтверждение на каждую группу:

- Claude: `~/.agents/skills/gstack`, пустые каталоги `~/.agents/skills/gstack-*`, симлинк `~/.agents/skills/superpowers`, кэш `~/.claude/plugins/cache/compound-engineering-plugin`, записи `compound-engineering@compound-engineering-plugin` в `settings.json` и `installed_plugins.json`;
- Codex: `~/.codex/superpowers`, `~/.codex/compound-engineering`, `~/.codex/skills/compound-engineering`, `~/.codex/agents/compound-engineering/`, секции `[marketplaces.compound-engineering-plugin]`, `[plugins."compound-engineering@..."]`, `[plugins."superpowers@..."]` в `config.toml` с бэкапом файла.

Скрипт не запускается из Claude Code автоматически: глобальный deny на `rm` требует запуска пользователем.

## 7. Синк из upstream

`sources.yaml`:

```yaml
sources:
  - name: writing-plans
    repo: obra/superpowers
    ref: main
    path: skills/writing-plans
    patch: true
  - name: typesafe-ai
    repo: typesafe-ai/skills
    ref: main
    path: skills/typesafe-ai
  - name: gstack-plan-eng-review
    repo: garrytan/gstack
    ref: main
    path: plan-eng-review/SKILL.md.tmpl
    mode: watch
```

`scripts/sync.mjs`:

1. Для каждого источника скачивает tarball `https://codeload.github.com/<repo>/tar.gz/<ref>` во временную папку, берёт `path`.
2. Режим по умолчанию: трёхстороннее слияние пофайлово через `git merge-file` (base = старый `vendor/<name>`, ours = `skills/<name>`, theirs = новый upstream). Файлы, которые мы не меняли, просто обновляются; изменённые сливаются; конфликт оставляет маркеры `<<<<<<< ours` в `skills/<name>/`, скрипт завершается с кодом 1 после обработки остальных источников. `patches/<name>.patch` при этом только пересобирается как запись наших правок.
3. Режим `watch`: файл кладётся в `vendor/<name>/`, при смене хеша в лог попадает diff. `skills/` не трогается.
4. Обновляет `sources.lock.json`: `{name: {commit, hash, syncedAt}}`.
5. `make repatch`: пересобирает `patches/<name>.patch` как `diff -ruN vendor/<name> skills/<name>` для источников с `patch: true`. Запускается после ручных правок в `skills/`; синк делает то же автоматически.

`.github/workflows/sync.yml`: cron раз в неделю плюс `workflow_dispatch`. Шаги: checkout, node 20, `node scripts/sync.mjs`, `peter-evans/create-pull-request` с ветвью `sync/upstream`, заголовком «sync: upstream YYYY-MM-DD» и телом из лога синка. При коде 1 PR всё равно создаётся с лейблом `needs-attention`.

## 8. README

Разделы:

1. Что это и зачем: личный дистрибутив скиллов, почему копии с патчами, а не плагины.
2. Флоу: диаграмма mermaid плюс ASCII, по шагу на скилл, где во флоу участвует TypeSafe и Codex.
3. Таблица скиллов: имя, источник со ссылкой на upstream, автор, лицензия, тип (свой / копия / копия с патчем), описание в одну строку.
4. Установка: требования (Node 20+, `codex`, Orca опционально, `TYPESAFE_API_KEY`), `make install`, где лежит ключ.
5. Обновление: `make sync`, что делает GitHub Action, как читать PR синка, `make repatch`.
6. Добавление нового источника в `sources.yaml`.
7. Удаление: `make uninstall`, `make cleanup`.
8. Атрибуция и лицензия (MIT, `NOTICE`).

## 9. Тестирование

- `scripts/typesafe-judge.mjs`: unit-тесты на формулу confidence и на разбор ответа SDK с замоканным клиентом; один живой smoke-тест при наличии ключа.
- `scripts/sync.mjs`: тест на локальном tarball-фикстуре: чистая копия, наложение патча, конфликт патча (код 1 и `.rej`), режим watch, обновление lock.
- `scripts/install.mjs`: тест в временном `HOME`: симлинки, идемпотентность хука и строки в AGENTS.md.
- `scripts/reviewer.sh`: тест с фейковыми `orca` и `codex` в `PATH`: порядок фолбэков и код 3.
- Скиллы: прогон `kickoff` → `writing-plans` → `plan-review` на этом же репо как ручная проверка перед первым релизом.

## 10. Решения, принятые в брейнсторме

- Порог уверенности, а не автопилот и не подсказка.
- Скрипт с JS SDK, а не curl и не MCP.
- Ключ в `env` `~/.claude/settings.json`.
- Копии с патчами, а не вызов плагина; плагин superpowers удаляется.
- Промпт-методика gstack в своём файле с контролем дрейфа, а не автоизвлечение.
- Ревьюер: Orca → `codex exec` → Claude.
- Находки ревью через TypeSafe, один повторный круг.
- Исполнение через `subagent-driven-development`, задачные ревью на Claude, финальное через Codex.
- Старый `code-review` удаляется.
- Первая версия: только флоу, `typesafe-ai`, `systematic-debugging`, `tdd`, `verification`.
- Обновление: GitHub Action по расписанию с PR.
- gstack и compound-engineering удаляются у Claude и Codex.
