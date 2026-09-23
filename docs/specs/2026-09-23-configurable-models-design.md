# Дизайн: модели, effort и ключ TypeSafe в одном конфиге

Дата: 2026-09-23. Статус: согласован в kickoff, исправлен по ревью спеки (раунды 1 и 2, §6).

## 1. Цель

Когда выходит новая модель, пользователь переключает её **одной правкой** и не ищет, где она зашита. Это касается трёх слоёв дистро:

- **Claude-сабагенты** — implementer, ревьюеры, fix-субагент, запасной внешний ревьюер и поиск в kickoff. Сейчас это `general-purpose` с текстом `model: opus` в 8 точках вызова скиллов (7 ролей), effort не задаётся нигде.
- **Codex-ревьюер** в `plan-review` и `review`. Сейчас его настройки лежат в `config/reviewer.json`.
- **Судья TypeSafe** (Jev). Сейчас модель берётся из дефолта SDK.

Второе. API-ключ TypeSafe должен жить в одном месте для Claude Code и Codex, а не дублироваться в `~/.claude/settings.json` и `~/.zshenv`.

Жёсткое требование пользователя: сабагенты вызываются **без имени и в фоне**. Параметр `name` в вызове Agent tool открывает на этой машине отдельное окно, и это недопустимо.

## 2. Не входит

- Настройка модели и effort сабагентов, которых порождает Codex (`spawn_agent`), когда скиллы работают под Codex. Формат агентов в Codex-плагинах не документирован, и тестов на это нет. Сама инструкция вызова через `spawn_agent` в каждой точке сохраняется (§4.4): вне рамок только модель и effort этих сабагентов.
- Переопределение модели Claude-сабагента на один прогон через env. Определения агентов статичны; см. §4.5.
- Проверка того, что роли, пишущие код, стоят на Opus. Правило пользователя остаётся на его совести (решение 8).
- Автоматический перенос ключа из `~/.claude/settings.json` и `~/.zshenv`. README описывает, как перенести его вручную.
- Ограничение инструментов по уровням (решение 10).

## 3. Установленные факты

- Frontmatter агента поддерживает `model` (алиасы `opus`/`sonnet`/`haiku`/`fable`, `inherit` или полный id) и `effort` (`low|medium|high|xhigh|max`). Официальный плагин `claude-security` отгружает агентов с `model: sonnet|inherit` и `effort: xhigh`.
- У Agent tool нет параметра effort: effort задаётся только определением агента. Явный параметр `model` в вызове перекрывает `model` из frontmatter.
- Агенты плагина адресуются как `<plugin>:<agent>`, пользовательские — из `~/.claude/agents/*.md`. Этого каталога на машине сейчас нет. Определение в проектном `.claude/agents/` с тем же именем перекрывает пользовательское ([scope precedence](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope)).
- Поле `name:` во frontmatter агента — идентификатор **типа**, окна оно не открывает. Окно открывает только параметр `name` вызова Agent tool.
- Алиас семейства зависит от модели родительской сессии ([model resolution](https://code.claude.com/docs/en/sub-agents#choose-a-model)). Если родитель сам работает на модели этого семейства, сабагент с `model: opus` получает **точную модель родителя**. Только в остальных случаях алиас даёт новейший Opus (сейчас Opus 5.5). Сессия, закреплённая на старом Opus, держит сабагентов на той же версии. Полный id в `model` закрепляет версию независимо от родителя.
- Агенты (`agents/`) — компонент плагина Claude Code. `.codex-plugin/plugin.json` ставит в Codex тот же каталог `skills/`, но агентов не объявляет, поэтому в Codex-сессии типов `verus-*` нет. Сабагентов Codex порождает своим инструментом `spawn_agent`.
- В `~/.codex/config.toml` пользователя стоят `model = "gpt-6-astra"` и `model_reasoning_effort = "high"` — те же значения, что закреплены в `config/reviewer.json`. Без `-m` Codex берёт модель из своего конфига.
- `scripts/reviewer.sh` по умолчанию хранит хэндл Orca-терминала в `$REPO/.context/${TITLE}-session`: один файл на репо и заголовок, и ни один скилл не передаёт `--session-file`. Если `orca terminal show` по сохранённому хэндлу проходит, терминал переиспользуется. `orca terminal create --command "codex -m … -c model_reasoning_effort=…"` запускается, только когда живого хэндла нет. Закрывать разрешено только терминал, созданный этим же прогоном (`CREATED_HANDLE`).
- Без `node` `reviewer.sh` намеренно отключает только Orca-ветку («node not found; Orca path disabled»), а `codex exec` продолжает работать с env и умолчаниями. Два теста в `tests/reviewer.test.mjs` закрепляют этот путь.
- `JSON.parse` включает в сообщение об ошибке кусок входа. Проверено: `Unexpected token 's', ..."apiKey": ts_SECRET12"... is not valid JSON`. Судья печатает `err.message` как есть (`scripts/typesafe-judge.mjs`, строки около 253 и 260).
- SDK TypeSafe читает `TYPESAFE_API_KEY` и `TYPESAFE_DEFAULT_MODEL`. По умолчанию модель — `jev-latest`, и `systemOne` принимает `model` на каждый запрос. `new TypeSafeClient({ apiKey })` принимает ключ явно.
- Репозиторий `VerusK/claude-skills` публичный, из него ставится плагин. Кэш плагина при каждом обновлении заменяется целиком.

## 4. Дизайн

### 4.1 Два слоя конфига

**Репозиторный — `config/models.json`**, коммитится и описывает умолчания дистро:

```json
{
  "subagents": {
    "worker":   { "model": "opus", "effort": "high" },
    "reviewer": { "model": "opus", "effort": "xhigh" },
    "explorer": { "model": "opus", "effort": "medium" }
  },
  "codex": { "model": "default", "reasoning": "default" },
  "judge": { "model": "jev-latest" }
}
```

Ключи в `subagents` — имена **уровней**, а не идентификаторы агентов. Уровень `<tier>` соответствует файлу `agents/verus-<tier>.md` с `name: verus-<tier>`. В плагине этот тип адресуется как `verus-skills:verus-<tier>` (§4.3).

**Локальный — `~/.verus-skills/config.json`**, живёт вне репо, права 0600, переживает обновления плагина. Все поля необязательны:

```json
{
  "typesafe": { "apiKey": "ts_..." },
  "codex":    { "model": "…", "reasoning": "…" },
  "judge":    { "model": "…" }
}
```

Секрета в репозиторном конфиге быть не может. Валидатор и тест отвергают в `config/models.json` любое поле, похожее на ключ (`apiKey`, `key`, `token`, `secret`, в любом регистре).

`config/reviewer.json` удаляется. `config/judge.json` остаётся только для порогов.

### 4.2 Приоритеты

| Значение | Порядок (первое заданное побеждает) |
|---|---|
| модель и effort уровня сабагентов | `config/models.json` → frontmatter агентов (через `make models`) |
| модель Codex | env `REVIEWER_CODEX_MODEL` > локальный `codex.model` > репозиторный `codex.model` > `default` |
| effort Codex | env `REVIEWER_CODEX_REASONING` > локальный `codex.reasoning` > репозиторный `codex.reasoning` > `default` |
| модель судьи | env `TYPESAFE_DEFAULT_MODEL` > локальный `judge.model` > репозиторный `judge.model` > `jev-latest` |
| API-ключ TypeSafe | env `TYPESAFE_API_KEY` > локальный `typesafe.apiKey` |

Для Codex значение `default` означает, что соответствующий флаг не передаётся (`-m` или `-c model_reasoning_effort`), и Codex берёт настройку из `~/.codex/config.toml`. Модель и effort решаются независимо.

Без `node` `reviewer.sh` пропускает оба файла конфига: модель и effort Codex берутся только из env, иначе `default` (§4.6).

### 4.3 Агенты плагина

`agents/verus-worker.md`, `agents/verus-reviewer.md`, `agents/verus-explorer.md`. Префикс `verus-` нужен, чтобы вызов не ушёл к чужому агенту с общим именем вроде `worker` из `~/.claude/agents/` или проектного `.claude/agents/`. Frontmatter: `name` (`verus-worker` и т. д.), `description`, `model`, `effort`. Поля `tools` нет, поэтому набор инструментов полный, как у `general-purpose` сегодня. Тело — короткое описание роли и строка «Do not dispatch subagents; follow the task prompt exactly».

| Ключ уровня в `config/models.json` | Тип агента (симлинковая установка / плагин) | Роли |
|---|---|---|
| `worker` | `verus-worker` / `verus-skills:verus-worker` | SDD implementer, fix-субагент в `review` |
| `reviewer` | `verus-reviewer` / `verus-skills:verus-reviewer` | SDD task-reviewer и re-reviewer, plan-document-reviewer в writing-plans, запасной внешний ревьюер в `plan-review` и `review` |
| `explorer` | `verus-explorer` / `verus-skills:verus-explorer` | поиск в kickoff |

`scripts/models.mjs` (цель `make models`) делает три вещи:
- читает и валидирует `config/models.json`: все три уровня на месте, модель — непустая строка, effort входит в допустимый набор, полей-секретов нет;
- переписывает в `agents/verus-{worker,reviewer,explorer}.md` **только** строки `model:` и `effort:` во frontmatter;
- на кривом конфиге падает, не записав ни одного файла.

Проверки на Opus нет.

Занятый идентификатор — ошибка, а не пропуск. Инсталлер до любой записи проверяет `~/.claude/agents/verus-{worker,reviewer,explorer}.md`. Если там лежит чужой файл или симлинк не в этот и не в другой чекаут дистро, инсталлер ничего не пишет (ни скиллов, ни агентов, ни хука), выходит с ненулевым кодом и называет файл: `~/.claude/agents/verus-worker.md is not ours; move it away and re-run`. `--force` эту проверку не обходит. Проектный `.claude/agents/` инсталлер не видит. Префикс `verus-` делает случайное перекрытие оттуда маловероятным, а плагинная форма `verus-skills:verus-<tier>` адресует агента плагина явно.

### 4.4 Точки вызова в скиллах и «без окон»

Все 8 точек вызова (7 ролей) получают инструкцию для каждого хоста. Типы агентов `verus-*` — только для Claude Code.

**Claude Code:**
- тип агента назван в двух формах, как в hand-off'ах: `` `verus-worker` (`verus-skills:verus-worker` when installed as a plugin) ``;
- вызов описан как `subagent_type` = этот тип, **unnamed** (без параметра `name`) и **in the background**;
- нет ни `model: opus`, ни `general-purpose`, ни иного параметра `model`: он перекрыл бы frontmatter.

**Codex:**
- отдельная строка вида `In a Codex session: dispatch the same prompt with spawn_agent, unnamed, in the background; pass no model`;
- ни типов `verus-*`, ни `subagent_type`, ни модели в этой строке нет. Модель сабагентов Codex вне рамок (§2);
- в `plan-review` и `review` (exit 3) остаётся запасной путь для хоста вообще без инструмента сабагентов: провести ревью самому и пометить это в заголовке отчёта. Пример «(e.g. a Codex session)» из этой фразы убирается: у Codex есть `spawn_agent`, и для него теперь есть своя строка.

Список точек: `skills/subagent-driven-development/implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md`, `skills/writing-plans/plan-document-reviewer-prompt.md`, `skills/plan-review/SKILL.md` (exit 3), `skills/review/SKILL.md` (exit 3 и fix wave), `skills/kickoff/SKILL.md` (Explore). Модельный раздел `subagent-driven-development/SKILL.md` («Every subagent dispatched by this skill uses `model: opus`») переписывается под типы агентов в Claude Code и `spawn_agent` в Codex. После правки SDD и writing-plans выполняется `make repatch`.

`USING.md` и `CLAUDE.md` вместо «Subagents use `model: opus`» формулируют правило по хостам:
- в Claude Code сабагенты запускаются через `subagent_type` как типы агентов дистро (`verus-worker`/`verus-reviewer`/`verus-explorer`, в плагине с префиксом `verus-skills:`), модель и effort берутся из `config/models.json`;
- в Codex — через `spawn_agent`, без модели;
- на обоих хостах вызов unnamed, in the background, никогда не `name`.

Спека прямо фиксирует: `name:` во frontmatter агента — идентификатор типа, окна он не открывает.

### 4.5 Как переключить модель

| Что | Как |
|---|---|
| новая версия внутри семейства (Opus 5.5 → 5.6) | если родительская сессия на новейшем Opus или вне семейства Opus — ничего, алиас `opus` подхватит новую версию. Если сессия закреплена на старом Opus, сабагенты остаются на её точной версии (§3). Тогда нужно переключить сессию или закрепить полный id (например, `claude-opus-5-6`) в `config/models.json` → `make models`. Закреплённый id не обновляется сам, и при следующем релизе его меняют вручную |
| другой уровень или effort у сабагентов | правка `config/models.json` → `make models`; симлинковая установка видит изменение сразу, плагин — после релиза |
| модель Codex | правка `~/.codex/config.toml` (при `default`) или `codex.model` в локальном либо репозиторном конфиге; на один прогон — `REVIEWER_CODEX_MODEL`. Каждое новое ревью стартует свежий Orca-терминал (§4.6), поэтому любая смена, включая правку `~/.codex/config.toml` при `default`, действует со следующего ревью |
| модель судьи | `judge.model` в локальном или репозиторном конфиге; на один прогон — `TYPESAFE_DEFAULT_MODEL` |

### 4.6 Компоненты

| Файл | Изменение |
|---|---|
| `config/models.json` | новый (§4.1) |
| `config/reviewer.json` | удаляется |
| `agents/verus-{worker,reviewer,explorer}.md` | новые, frontmatter генерирует `make models` |
| `scripts/models.mjs`, `Makefile` | новые: цель `models` и валидация |
| `scripts/config.mjs` | новый: загрузка и слияние двух слоёв (`loadModels()`, `loadLocal(home?)`, `resolveCodex(env, home?)`, `resolveJudgeModel(env, home?)`, `resolveApiKey(env, home?)`) — общий модуль для судьи, `reviewer.sh` и инсталлера. CLI печатает только запрошенную несекретную секцию. `node scripts/config.mjs codex` выводит ровно две строки: итоговые модель и effort Codex. Секции `typesafe` в CLI нет, и ключ он не печатает никогда. Ошибки редактируются по §4.7 |
| `scripts/typesafe-judge.mjs` | модель и ключ берёт из `config.mjs`, передаёт `model` в `systemOne`, ключ — в `new TypeSafeClient({ apiKey })`; guard «нет ключа» проверяет итоговый ключ, а не только env; ошибки печатает по правилам §4.7 |
| `scripts/reviewer.sh` | модель и effort Codex берёт через `node scripts/config.mjs codex`; при `default` флаг не передаётся ни в Orca-, ни в `codex exec`-ветке. Без `node` `config.mjs` не вызывается и работает путь без Node (ниже). Orca-терминал живёт в пределах одного ревью: без `--session-file` закрывается после отчёта, с ним — остаётся до `--close-session`; новый режим `--close-session <file>` (ниже) |
| `skills/plan-review/SKILL.md`, `skills/review/SKILL.md` | на раунде 1 выбирают файл сессии этого ревью и **сначала всегда** вызывают `reviewer.sh --close-session <file>` — он закрывает осиротевший терминал прерванного прошлого ревью и удаляет его файл; только потом запускают раунд 1 с `--session-file <file>`. Раунд 2 передаёт тот же файл. Когда ревью закончено (второго раунда не будет или он прошёл), снова вызывают `reviewer.sh --close-session <file>` |
| `scripts/install.mjs` | линкует `agents/verus-*.md` в `~/.claude/agents/` (снятие при uninstall, перенацеливание своих ссылок — как у скиллов). Чужой файл на месте нужного идентификатора — ненулевой выход до любой записи (§4.3), а не пропуск. Проверка ключа учитывает локальный файл и значение ключа не печатает |
| 8 точек вызова, `USING.md`, `CLAUDE.md` | §4.4: инструкции для Claude Code и Codex |
| `README.md` | новый раздел «Models and effort» (включая зависимость алиаса от модели сессии и закрепление полным id) и раздел про ключ: `~/.verus-skills/config.json` с `chmod 600` вместо `env` в `settings.json`; env остаётся альтернативой |
| `README.md`, `docs/plugin-acceptance.md` | `rm -rf ~/.verus-skills` → `rm -f ~/.verus-skills/root` (иначе стирается ключ); в чек-лист — шаги про агентов, закреплённую сессию и коллизию имён (§5) |

**`reviewer.sh`: путь без Node.** Если `node` не найден, `reviewer.sh`:
- не вызывает `config.mjs` и не читает ни `config/models.json`, ни `~/.verus-skills/config.json`;
- берёт `CODEX_MODEL="${REVIEWER_CODEX_MODEL:-default}"` и `CODEX_REASONING="${REVIEWER_CODEX_REASONING:-default}"`;
- печатает одну строку в stderr: `node not found; Orca path disabled, config ignored (env or default only)`;
- запускает `codex exec` как обычно, при `default` без соответствующего флага.

Битый конфиг в этом режиме не мешает, потому что его никто не читает. Node — не жёсткое требование.

**`reviewer.sh`: один Orca-терминал на одно ревью** (решение 13).
- Умолчание `$REPO/.context/${TITLE}-session` убирается. Без `--session-file` терминал не переиспользуется: каждый запуск создаёт свежий терминал с текущими флагами и, когда отчёт записан, закрывает его. Это `CREATED_HANDLE`, так что действующее правило закрытия это разрешает; одиночные запуски терминалов не копят. С `--session-file` терминал после успешного отчёта остаётся открытым до `--close-session`. Файлы `.context/plan-review-session` и `.context/review-session` старых версий больше не читаются и не пишутся; терминалы, на которые они указывают, остаются открытыми, и README говорит, что их можно закрыть руками.
- Переиспользование — только внутри одного ревью. На раунде 1 `plan-review` и `review` выбирают файл `.context/<title>-<stem отчёта раунда 1>-session`. Имя детерминированное и уникальным для ревью не является: `plan-review` пишет отчёт по одному и тому же пути при каждом ревью данного плана, поэтому ревью, прерванное после раунда 1 (до `--close-session`), оставляет живой терминал и файл с тем же именем. Отсюда правило: раунд 1 **всегда** начинается с `reviewer.sh --close-session <file>` — он закрывает осиротевший терминал прошлого ревью и удаляет его файл, — и только потом запускает свежий терминал с `--session-file <file>`. Раунд 2 передаёт тот же файл без закрытия и попадает в тот же терминал, то есть видит контекст раунда 1. Формат файла не меняется: в нём только хэндл, и пишется он, как сейчас, после успешного отчёта.
- Поэтому раунд 1 свеж по построению в обоих скиллах: у `review` путь отчёта и так получает новый суффикс `-N` на каждый прогон, у `plan-review` — нет, и свежесть держится на закрытии в начале раунда 1. Каждое новое ревью подхватывает любые изменения: env, локальный и репозиторный конфиг, а при `default` — правку `~/.codex/config.toml`. Сверять настройки не нужно.
- Смена настроек между раундом 1 и раундом 2 одного ревью не отслеживается: раунд 2 работает на модели раунда 1. Это принятая граница решения 13.
- Новый режим `reviewer.sh --close-session <file>`: читает хэндл из файла, закрывает этот терминал (`orca terminal close`), удаляет файл и выходит с кодом 0; отсутствующий файл или уже закрытый терминал — тоже 0. Других терминалов он не трогает. Скиллы вызывают его дважды: в начале раунда 1 (убрать сироту прерванного ревью) и когда ревью закончено, чтобы терминалы не копились.
- Если свежий терминал не заработал и прогон ушёл в `codex exec`, созданный терминал закрывается, как сейчас, а файл сессии не пишется.

### 4.7 Ошибки

- `config/models.json` битый или неполный:
  - `make models` падает с понятным сообщением и не пишет файлы;
  - судья выходит с кодом 2 — скилл спрашивает пользователя, как при недоступном судье;
  - `reviewer.sh` выходит с кодом 1, если `node` есть. Без `node` конфиг не читается (§4.6).
- `~/.verus-skills/config.json` отсутствует — это нормально. Битый JSON — судья выходит с кодом 2, `reviewer.sh` (при наличии `node`) выходит с кодом 1. Сообщение в обоих случаях содержит только имя файла (ниже).
- Локальный файл с ключом доступен группе или всем (`mode & 0o077`) — судья пишет предупреждение в stderr и продолжает работу.
- Ключа нет ни в env, ни в локальном файле — прежнее поведение: exit 2, «judge unavailable».
- Файлы агентов разошлись с конфигом — падает тест.
- Идентификатор агента занят чужим файлом — инсталлер выходит с ненулевым кодом и ничего не пишет (§4.3).

**Редактирование секретов.** Локальный файл хранит `typesafe.apiKey`, поэтому ни одно сообщение об ошибке не должно выносить его содержимое наружу.
- `loadLocal` перехватывает любую ошибку чтения и разбора и бросает новую ошибку с сообщением, где назван только файл: `invalid JSON in ~/.verus-skills/config.json`. Исходный `err.message` парсера никуда не передаётся: ни в текст, ни в `cause`, ни в стек.
- Ни одна ошибка валидации (`models.mjs`, `config.mjs`, судья, `reviewer.sh`, инсталлер) никогда не включает значение из конфига. Ошибки называют поле и ожидание, но не значение: `codex.model must be a non-empty string`, `typesafe.apiKey must be a string`.
- CLI `config.mjs`, которым пользуется `reviewer.sh`, печатает только запрошенные поля: `node scripts/config.mjs codex` выводит модель и effort Codex и ничего больше, ключ — никогда.
- Судья перед печатью любой ошибки (строки около 253 и 260) заменяет в тексте итоговый ключ, если он известен, на `[redacted]`. Это страховка на случай, если ключ попадёт в сообщение SDK или сети.

### 4.8 Попутные исправления

Два бага в том, как ревью и судья обращаются с находками. Оба найдены в работе над плагином и не связаны с моделями, но правятся на этой ветке, чтобы пройти план, ревью и тесты вместе с остальным.

**1. Отложенные minor не доходят до финального ревью** (решение 18).
- `skills/subagent-driven-development/SKILL.md:329` велит записывать в леджер `Task <N>: minor (deferred): <one-liner>` строчными; так же написано в upstream-копии `vendor/`. А `skills/review/SKILL.md:22` и его блок сбора ищут `Minor \(deferred\)` с учётом регистра. В прошлом прогоне паттерн поймал 18 строк `Ruling` и ни одной из 47 отложенных minor.
- Исправление: сбор строк леджера в `review` становится регистронезависимым (`grep -iE 'minor \(deferred\)|ruling|parked'`), а его текст называет маркер так, как его пишет SDD. SDD не меняется и остаётся совпадающим с upstream.
- Контрактный тест извлекает из SDD шаблон строки леджера (`Task <N>: minor (deferred): …`) и проверяет, что паттерн `review` его ловит. Если upstream переименует маркер, сюита покраснеет, а не потеряет находки молча.

**2. Вопросы судье о находках ревью — не печать** (решение 17).
- Сейчас раздел 3 «Triage findings» в `review` и `plan-review` задаёт на каждую находку A «Fix as proposed», B «Fix differently» (если есть) и C «Reject … because <reason>». На практике B опускался, C уходил без причины, и судья отвечал 99–100% A. Когда те же находки переспросили вопросом «как чинить» с реальными вариантами, судья разошёлся (например, 62/24/14), и выбранный фикс отличался от предложенного ревьюером.
- Новое правило в разделе 3 обоих скиллов:
  - вопрос звучит как «как исправить <находку>?» и даёт 2–4 конкретных варианта исправления, каждый со своим последствием;
  - вариант «оставить как есть» допустим, только если в его описании записан сильнейший довод;
  - если разумный способ исправления один (например, воспроизведённый баг с очевидным фиксом), судья не вызывается: находка принимается, в чате печатается строка `accepted without the judge: <доказательство>`, и она же попадает в раздел решений плана;
  - шаблон «Fix as proposed / Fix differently / Reject» убирается.
- `skills/kickoff/judge.md`, раздел Rules, получает то же общее правило: каждый вариант должен быть таким, что его мог бы выбрать разумный инженер; вариант «отклонить» без аргумента не добавляется.
- Правятся только собственные скиллы (`review`, `plan-review`, `kickoff`), `make repatch` не нужен.

## 5. Тестирование

1. `tests/models.test.mjs`:
   - `config/models.json` валиден;
   - три файла `agents/verus-*.md` совпадают с ним по `model`/`effort`, а их `name` равен `verus-<ключ уровня>`;
   - `make models` на песочнице перегенерирует их;
   - на кривом конфиге (неизвестный effort, нет уровня, поле `apiKey`) падает, не записав ни одного файла;
   - меняются только строки `model:`/`effort:`, остальной frontmatter и тело не тронуты.
2. `tests/config.test.mjs` — приоритеты для каждого слоя на песочнице с подставным `HOME` и env:
   - env > локальный > репозиторный > default;
   - `default` у Codex не порождает флага;
   - ключ из локального файла принимается, env его перекрывает;
   - предупреждение о правах файла;
   - битый локальный JSON;
   - **секрет не утекает**. Подставной секрет `ts_DUMMY_SECRET_123` прогоняется через битый локальный файл (незакавыченное значение `apiKey`) и через ошибки валидации (`typesafe` строкой вместо объекта, `typesafe.apiKey` не строкой, неверный тип `codex.model` рядом с ключом). Ошибка `loadLocal` называет только файл. Stdout и stderr `node scripts/config.mjs codex` не содержат секрета ни при сбое, ни при успехе, а при успехе выводят ровно две строки.
3. `tests/judge.test.mjs`:
   - в `systemOne` уходит разрешённый `model`;
   - ключ из локального файла доходит до клиента;
   - guard срабатывает, только если ключа нет нигде;
   - при битом локальном файле с подставным секретом судья выходит с кодом 2, называет файл, и секрета нет ни в stdout, ни в stderr;
   - ошибка клиента, в тексте которой есть ключ, печатается с `[redacted]`.
4. `tests/reviewer.test.mjs`:
   - при `default` в командной строке нет `-m` и `model_reasoning_effort`; явные значения и env передаются. Существующие тесты с `config/reviewer.json` переводятся на `models.json`;
   - при битом локальном конфиге с подставным секретом выход 1, секрета нет в stdout и stderr;
   - сессия на одно ревью. Сейчас тесты «reuses an existing Orca session» и «a reused Orca session terminal is never closed» опираются на умолчание `.context/<title>-session`; оба переводятся на явный `--session-file`. Новые случаи:
     - без `--session-file` два прогона подряд — два `terminal create`, и `.context/<title>-session` не читается и не пишется, даже если такой файл лежит; каждый из двух терминалов закрыт (`terminal close` с его хэндлом) после записи своего отчёта;
     - прогон с `--session-file` после успешного отчёта оставляет терминал открытым (`terminal close` не вызывается) и пишет хэндл в файл;
     - с одним и тем же `--session-file` второй прогон (раунд 2) переиспользует терминал без `terminal create`;
     - перезапуск ревью того же плана со сменой настроек: файл сессии прошлого ревью и его терминал ещё живы (ревью прервано после раунда 1). Последовательность раунда 1 из скилла — `--close-session <file>`, затем прогон с тем же `--session-file` — закрывает осиротевший терминал, создаёт новый (`terminal create`) с новыми флагами и пишет в файл новый хэндл;
     - второй прогон без `--session-file` после смены модели или effort создаёт терминал с новыми флагами; при `default` в нём нет `-m` и `model_reasoning_effort`;
     - `--close-session <file>` закрывает ровно терминал из файла, удаляет файл и выходит с 0; на отсутствующем файле и уже закрытом терминале — тоже 0;
   - `tests/patched-skills.test.mjs` (или отдельный тест скиллов): `plan-review` и `review` на раунде 1 вызывают `--close-session <file>` до запуска ревьюера, передают один и тот же `--session-file` в обоих раундах и вызывают `--close-session` в конце ревью;
   - путь без Node. Тесты «skips Orca when node is unavailable» и «codex exec stays pinned when node is unavailable» остаются. Оба кладут в песочницу `config/models.json` и локальный файл с отличимыми значениями и проверяют, что в команде `codex exec` этих значений нет, то есть конфиг проигнорирован, и что stderr содержит `config ignored`. Во втором тесте проверка `model_reasoning_effort=high` меняется: без env флага нет, потому что умолчание теперь `default`, а не зашитое `high`.
5. `tests/patched-skills.test.mjs`:
   - в скиллах не осталось `model: opus` и `general-purpose` в точках вызова;
   - каждая из 8 точек содержит инструкцию для Claude Code: свой тип `verus-*` в двух формах, `subagent_type`, «unnamed» и «background»;
   - каждая из 8 точек содержит инструкцию для Codex: `spawn_agent`, «unnamed» и «background», без типа `verus-*` и без модели;
   - ни в одной нет параметров `name:` и `model:`;
   - во фразе про хост без инструмента сабагентов больше нет «e.g. a Codex session»;
   - `USING.md` формулирует правило для обоих хостов.
6. `tests/install.test.mjs`:
   - линковка, снятие и перенацеливание своих ссылок для `agents/verus-*.md`;
   - **коллизия имени**. Чужой обычный файл `~/.claude/agents/verus-worker.md`, а отдельно — симлинк на чужой путь, дают ненулевой выход с сообщением, где назван файл. Ни одна ссылка на скилл или агента не создана, хук не записан, чужой файл не тронут. `--force` проверку не обходит. Uninstall чужой файл не удаляет;
   - проверка ключа видит локальный файл и не печатает его значение.
7. `tests/plugin.test.mjs`: три агента `agents/verus-*.md` на месте; при наличии бинаря `claude plugin validate` их принимает.

8. Попутные исправления (§4.8):
   - контракт леджера: тест извлекает шаблон строки `Task <N>: minor (deferred): …` из `skills/subagent-driven-development/SKILL.md` и проверяет, что паттерн сбора в `skills/review/SKILL.md` его ловит; ещё один случай — прогнать блок сбора `review` на песочном леджере со строками `minor (deferred)`, `Ruling` и `parked` и убедиться, что выведены все три;
   - правила триажа: в разделе 3 `review` и `plan-review` нет шаблона `Fix as proposed` / `Reject`, есть формулировка «как исправить» с 2–4 вариантами, правило про довод для «оставить как есть» и строка `accepted without the judge`; в `skills/kickoff/judge.md` есть правило «никаких вариантов без аргумента».

Ручная приёмка (добавляется в `docs/plugin-acceptance.md`):
- `claude plugin details verus-skills@verus-skills` показывает `Agents (3)`: `verus-worker`, `verus-reviewer`, `verus-explorer`;
- вызов `verus-skills:verus-worker` без `name` не открывает окна;
- debug-лог сессии показывает модель и effort агента из конфига;
- закреплённая родительская сессия: в сессии, запущенной на полном id более старого Opus, debug-лог показывает, что `verus-worker` с `model: opus` работает на той же старой версии. После закрепления полного id в `config/models.json` и `make models` агент работает на закреплённом id;
- коллизия: при чужом `~/.claude/agents/verus-worker.md` `make install` падает с ненулевым кодом, называет файл, и ни одна ссылка не создана. Работа не уходит к чужому агенту молча;
- в Codex-сессии SDD-implementer запускается через `spawn_agent`, без имени и отдельного окна;
- судья работает с ключом только из `~/.verus-skills/config.json` при снятом `TYPESAFE_API_KEY`.

## 6. Решения

### 1. Где лежат настройки всех трёх слоёв — `auto`

```
Решение (Jev): Where should the model and effort settings for all three layers live?
  A. One new config/models.json           99%
  B. Add models.json, keep reviewer.json  1%
  Выбрано: A, confidence 0.97, данных 0.71 → принято автоматически
```

### 2. Умолчание для модели и effort Codex — `auto`

```
Решение (Jev): What should the shipped default for the Codex reviewer's model and reasoning effort be?
  A. "default": inherit from Codex config  99%
  B. Explicit names                        1%
  Выбрано: A, confidence 0.98, данных 0.79 → принято автоматически
```

### 3. Как разрешается модель судьи — `auto`

```
Решение (Jev): How should the judge's model be resolved?
  A. env > config > jev-latest  100%
  B. config > env > jev-latest  0%
  C. Env only, no config entry  0%
  Выбрано: A, confidence 0.99, данных 0.600 → принято автоматически
```

Решение 11 расширило этот порядок локальным слоем: env > локальный > репозиторный > `jev-latest`.

### 4. Агенты в симлинковой установке — `auto`

```
Решение (Jev): How should the agent definitions reach the symlink (development) install, where no plugin is installed?
  A. Installer links agents too   99%
  B. Fallback to general-purpose  1%
  Выбрано: A, confidence 0.99, данных 0.64 → принято автоматически
```

Ревью спеки (раунд 1) уточнило: занятый чужим файлом идентификатор агента — ошибка инсталлера, а не пропуск (§4.3).

### 5. Сабагенты Codex — `auto`

```
Решение (Jev): Should this change also configure the model and effort of subagents that Codex spawns when the skills run under Codex?
  A. Out of scope  99%
  B. In scope      1%
  Выбрано: A, confidence 0.99, данных 0.73 → принято автоматически
```

Вне рамок только их модель и effort. Инструкция вызова через `spawn_agent` в каждой точке сохраняется (ревью спеки, раунд 1; §4.4).

### 6. Сколько типов агентов — `user`

```
Решение (Jev): How many plugin agent types should the distro ship to carry model and effort for its subagents?
  A. One per role (7)   7%
  B. Three tiers        88%
  C. One generic agent  5%
  Выбрано: B, confidence 0.82, данных 0.34 → спросить пользователя (мало данных)
```

Выбрано пользователем: **три уровня** — `worker`, `reviewer`, `explorer`. После ревью спеки (раунд 1) это имена уровней и ключи `config/models.json`, а типы агентов называются `verus-worker`, `verus-reviewer`, `verus-explorer` (§4.3).

### 7. Как значения попадают в файлы агентов — `auto`

```
Решение (Jev): How should the model and effort values in config/models.json get into the three agent definition files?
  A. Generated by make models, committed   99%
  B. Regenerated by the SessionStart hook  1%
  Выбрано: A, confidence 0.99, данных 0.78 → принято автоматически
```

### 8. Правило «пишущие роли — только Opus» — `user`

Вопрос задан пользователю напрямую: это его собственное правило, поэтому решение за ним.

- A. `make models` отказывает, если пишущая роль стоит не на Opus.
- B. Только предупреждение.
- C. Без проверки.

Выбрано пользователем: **C, без проверки**.

### 9. Значения по умолчанию для уровней — `user`

```
Решение (Jev): What model and effort should config/models.json ship for the three subagent tiers?
  A. opus for all, effort by tier  84%
  B. inherit the session model     2%
  C. opus for all, no effort       14%
  Выбрано: A, confidence 0.76, данных 0.53 → спросить пользователя (мало данных)
```

Выбрано пользователем: **A** — worker opus/high, reviewer opus/xhigh, explorer opus/medium.

### 10. Ограничение инструментов по уровням — `auto`

```
Решение (Jev): Should the three agent definitions restrict which tools each tier may use?
  A. No restriction                   86%
  B. Read-only reviewer and explorer  14%
  Выбрано: A, confidence 0.72, данных 0.76 → принято автоматически
```

### 11. Где хранить API-ключ TypeSafe — `user`

Вопрос касается учётных данных, поэтому судье не отдавался.

Пользователь предложил положить ключ в общий конфиг. `config/models.json` для этого не подходит по двум причинам: он коммитится в публичный репозиторий, а кэш плагина при обновлении заменяется. Пользователю предложены три варианта:

- A. `~/.verus-skills/config.json`: локальный файл с правами 0600, заодно локальный слой моделей для Codex и судьи.
- B. `config/local.json` в чекауте, добавленный в `.gitignore`. Работает только в симлинковой установке.
- C. Оставить ключ в env, как сейчас.

Выбрано пользователем: **A**.

### 12. Сабагенты без имени и окон — `user` (исходное требование)

Сабагенты вызываются без параметра `name` и в фоне: в Claude Code через `subagent_type`, в Codex через `spawn_agent`. Это закреплено тестом (§5, п. 5) и шагом приёмки.

### Ревью спеки, раунд 1 (Codex)

Ревьюер — настоящий Codex через Orca (`reviewer: orca`). Отчёт: `docs/reviews/VerusK-configurable-models-2026-09-23-docs-specs-2026-09-23-configurable-models-design-md.md`. Все шесть находок приняты судьёй автоматически.

```
Решение (Jev): How should the spec handle: a malformed local config that now holds the API key leaks key text through JSON.parse error messages, which the judge prints verbatim?
  A. Fix as proposed  100%
  C. Reject           0%
  Выбрано: A, confidence 1.00, данных 0.88 → принято автоматически
```

Применено: факт в §3, CLI `config.mjs` в §4.6, раздел «Редактирование секретов» в §4.7, тесты утечки в §5 (пп. 2–4).

```
Решение (Jev): How should the spec handle: reviewer.sh reuses a saved Orca terminal started with the previous Codex flags, so a changed config or one-run override never reaches the reviewer while that terminal lives?
  A. Fix as proposed  100%
  C. Reject           0%
  Выбрано: A, confidence 1.00, данных 0.84 → принято автоматически
```

Применено: факт в §3; способ исправления пересмотрен решением 13 — «один Orca-терминал на одно ревью» в §4.6, строка про Codex в §4.5, тесты сессий в §5 (п. 4).

```
Решение (Jev): How should the spec handle: replacing every dispatch instruction with Claude-only subagent_type identifiers leaves the same skills, installed in Codex, with no specified way to dispatch?
  A. Fix as proposed  100%
  C. Reject           0%
  Выбрано: A, confidence 0.99, данных 0.78 → принято автоматически
```

Применено: §2, факт в §3, инструкции для двух хостов и правило `USING.md` по хостам в §4.4, решения 5 и 12, тест обоих хостов в §5 (п. 5), шаг Codex в ручной приёмке.

```
Решение (Jev): How should the spec handle: generic agent names (worker, reviewer, explorer) plus the installer's skip-foreign-files policy can silently route a dispatch to someone else's agent of the same name?
  A. Fix as proposed  100%
  C. Reject           0%
  Выбрано: A, confidence 1.00, данных 0.86 → принято автоматически
```

Применено: идентификаторы `verus-*` и таблица «ключ уровня → тип агента» в §4.1 и §4.3, ошибка инсталлера при коллизии в §4.3, §4.6 и §4.7, тест и шаг приёмки в §5 (п. 6), примечания к решениям 4 и 6.

```
Решение (Jev): How should the spec handle: its claim that the opus alias always picks the newest Opus is wrong when the parent session runs an older Opus, because subagents then keep the parent's exact model?
  A. Fix as proposed  100%
  C. Reject           0%
  Выбрано: A, confidence 0.99, данных 0.86 → принято автоматически
```

Применено: факт в §3, строка «новая версия внутри семейства» в §4.5 (зависимость от модели сессии и закрепление полным id), README в §4.6, шаг с закреплённой сессией в ручной приёмке §5.

```
Решение (Jev): How should the spec handle: making reviewer.sh resolve its config through a Node script would regress its existing Node-free codex exec path?
  A. Fix as proposed (env/default fallback)  100%
  B. Make Node a hard prerequisite           0%
  C. Reject                                  0%
  Выбрано: A, confidence 0.99, данных 0.76 → принято автоматически
```

Применено: факт в §3, приоритеты в §4.2, «путь без Node» в §4.6, §4.7, проверки no-node тестов в §5 (п. 4).

### Пересмотр триажа ревью спеки

Вопросы судье в раунде 1 были собраны неправильно: у каждой находки было только «A. Fix as proposed» против «C. Reject» без аргумента, поэтому ответы 99–100% ничего не проверяли. По трём находкам с реальными альтернативами дизайна вопросы заданы заново, с конкурирующими вариантами.

### 13. Когда `reviewer.sh` переиспользует Orca-терминал — `user`

```
Решение (Jev): How should reviewer.sh decide whether to reuse a saved Orca Codex terminal, so that a changed model or effort reaches the reviewer?
  A. Settings-aware reuse                  14%
  B. One session per review run            62%
  C. Per-review scope plus settings check  24%
  D. No reuse at all                       0%
  Выбрано: B, confidence 0.48, данных 0.65 → спросить пользователя
```

Выбрано пользователем: **B, одна сессия на одно ревью**. Заменяет вариант «с учётом настроек», внесённый fix wave. Следствие, добавленное в спеку: режим `--close-session`, чтобы терминалы не копились.

### 14. Как точки вызова говорят обоим хостам, что запускать — `auto`

```
Решение (Jev): How should the 8 dispatch sites in the skills tell Claude Code and Codex what to dispatch?
  A. Two concrete lines at every site                  100%
  B. Tier word at sites, mapping in USING.md           0%
  C. Claude line at sites, one Codex rule in USING.md  0%
  Выбрано: A, confidence 0.99, данных 0.81 → принято автоматически
```

Совпадает с внесённым в §4.4. Решающий факт: `USING.md` не доходит до сабагентов и до сессий без хука, а текст скилла загружается всегда.

### 15. Идентификаторы агентов — `auto`

```
Решение (Jev): What identifiers should the three agent definitions use, given the collision risk under the symlink install?
  A. Prefixed: verus-worker etc.         100%
  B. Generic names, refuse on collision  0%
  Выбрано: A, confidence 1.00, данных 0.92 → принято автоматически
```

Совпадает с внесённым. Решающий факт: проектный `.claude/agents/<name>.md` инсталлер не видит.

### 16. `--force` и коллизия имён агентов — принято без судьи

`--force` не обходит проверку коллизии. Единственная альтернатива — тихо пропускать занятое имя — возвращает исходную находку 4, поэтому реального выбора нет и судья не вызывался.

### Ревью спеки, раунд 2 (Codex)

Ревьюер — настоящий Codex через Orca (`reviewer: orca`). Отчёт: `docs/reviews/VerusK-configurable-models-2026-09-23-docs-specs-2026-09-23-configurable-models-design-md-2.md`. Вердикт: READY WITH FIXES. Обе находки приняты судьёй автоматически, вопросы заданы с конкурирующими вариантами.

```
Решение (Jev): How should a new review be guaranteed a fresh Orca terminal when a previous review of the same plan left its session file and terminal alive?
  A. Unique run id per review                    7%
  B. Close-at-start with the deterministic name  93%
  C. Staleness limit                             0%
  Выбрано: B, confidence 0.90, данных 0.75 → принято автоматически
```

Применено: имя файла по stem отчёта сохранено, раунд 1 `plan-review` и `review` всегда начинается с `--close-session <file>` (§4.6: строка скиллов в таблице и раздел «один Orca-терминал на одно ревью»), тест перезапуска ревью того же плана и проверка закрытия в начале раунда 1 в тесте скиллов (§5, п. 4).

```
Решение (Jev): What should happen to the Orca terminal that a successful reviewer.sh run created when no --session-file was given?
  A. Close it after the report       99%
  B. Leave it; only skills clean up  1%
  Выбрано: A, confidence 0.99, данных 0.86 → принято автоматически
```

Применено: без `--session-file` `reviewer.sh` закрывает созданный терминал после отчёта, с `--session-file` оставляет его до `--close-session` (§4.6: строка `reviewer.sh` и раздел про сессии), расширенный тест двух прогонов и тест открытого терминала при `--session-file` (§5, п. 4).

### Попутные исправления (§4.8)

Добавлены по просьбе пользователя после второго раунда ревью спеки: оба бага обсуждались раньше в этой работе. Вопросы судье заданы по новому правилу — «как исправить», с реальными вариантами.

### 17. Как переписать триаж находок в review и plan-review — `auto`

```
Решение (Jev): How should the finding-triage instructions in review and plan-review be rewritten so judge questions are not rubber stamps?
  A. Keep A/B/C, make B and C real          9%
  B. Ask how to fix, not whether to accept  91%
  C. No judge for review findings           0%
  Выбрано: B, confidence 0.87, данных 0.68 → принято автоматически
```

### 18. Как чинить расхождение регистра `minor (deferred)` — `user`

```
Решение (Jev): How should the mismatch between the ledger line SDD writes (`minor (deferred)`) and the pattern review greps (`Minor \(deferred\)`) be fixed?
  A. Case-insensitive grep in review  32%
  B. Capitalize in SDD                1%
  C. Both plus a contract test        67%
  Выбрано: C, confidence 0.51, данных 0.64 → спросить пользователя
```

Выбрано пользователем: **C** — регистронезависимый сбор в `review` плюс контрактный тест; SDD не меняется.
