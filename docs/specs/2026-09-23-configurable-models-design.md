# Дизайн: модели, effort и ключ TypeSafe в одном конфиге

Дата: 2026-09-23. Статус: согласован в kickoff.

## 1. Цель

Когда выходит новая модель, пользователь переключает её **одной правкой** и не ищет, где она зашита. Это касается трёх слоёв дистро:

- **Claude-сабагенты** — implementer, ревьюеры, fix-субагент, запасной внешний ревьюер и поиск в kickoff. Сейчас это `general-purpose` с текстом `model: opus` в 8 точках вызова скиллов (7 ролей), effort не задаётся нигде.
- **Codex-ревьюер** в `plan-review` и `review`. Сейчас его настройки лежат в `config/reviewer.json`.
- **Судья TypeSafe** (Jev). Сейчас модель берётся из дефолта SDK.

Второе. API-ключ TypeSafe должен жить в одном месте для Claude Code и Codex, а не дублироваться в `~/.claude/settings.json` и `~/.zshenv`.

Жёсткое требование пользователя: сабагенты вызываются **без имени и в фоне**. Параметр `name` в вызове Agent tool открывает на этой машине отдельное окно, и это недопустимо.

## 2. Не входит

- Настройка сабагентов, которых порождает Codex (`spawn_agent`), когда скиллы работают под Codex. Формат агентов в Codex-плагинах не документирован, и тестов на это нет.
- Переопределение модели Claude-сабагента на один прогон через env. Определения агентов статичны; см. §4.5.
- Проверка того, что роли, пишущие код, стоят на Opus. Правило пользователя остаётся на его совести (решение 8).
- Автоматический перенос ключа из `~/.claude/settings.json` и `~/.zshenv`. README описывает, как перенести его вручную.
- Ограничение инструментов по уровням (решение 10).

## 3. Установленные факты

- Frontmatter агента поддерживает `model` (алиасы `opus`/`sonnet`/`haiku`/`fable`, `inherit` или полный id) и `effort` (`low|medium|high|xhigh|max`). Официальный плагин `claude-security` отгружает агентов с `model: sonnet|inherit` и `effort: xhigh`.
- У Agent tool нет параметра effort: effort задаётся только определением агента. Явный параметр `model` в вызове перекрывает `model` из frontmatter.
- Агенты плагина адресуются как `<plugin>:<agent>`, пользовательские — из `~/.claude/agents/*.md`. Этого каталога на машине сейчас нет.
- Поле `name:` во frontmatter агента — идентификатор **типа**, окна оно не открывает. Окно открывает только параметр `name` вызова Agent tool.
- Алиас `opus` сам резолвится в новейший Opus (сейчас Opus 5.5).
- В `~/.codex/config.toml` пользователя стоят `model = "gpt-6-astra"` и `model_reasoning_effort = "high"` — те же значения, что закреплены в `config/reviewer.json`. Без `-m` Codex берёт модель из своего конфига.
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

### 4.3 Агенты плагина

`agents/worker.md`, `agents/reviewer.md`, `agents/explorer.md`. Frontmatter: `name`, `description`, `model`, `effort`. Поля `tools` нет, поэтому набор инструментов полный, как у `general-purpose` сегодня. Тело — короткое описание роли и строка «Do not dispatch subagents; follow the task prompt exactly».

| Уровень | Роли |
|---|---|
| `worker` | SDD implementer, fix-субагент в `review` |
| `reviewer` | SDD task-reviewer и re-reviewer, plan-document-reviewer в writing-plans, запасной внешний ревьюер в `plan-review` и `review` |
| `explorer` | поиск в kickoff |

`scripts/models.mjs` (цель `make models`) делает три вещи:
- читает и валидирует `config/models.json`: все три уровня на месте, модель — непустая строка, effort входит в допустимый набор, полей-секретов нет;
- переписывает в трёх файлах **только** строки `model:` и `effort:` во frontmatter;
- на кривом конфиге падает, не записав ни одного файла.

Проверки на Opus нет.

### 4.4 Точки вызова в скиллах и «без окон»

Все 8 точек вызова (7 ролей) переходят на типы агентов. В каждой:

- тип агента назван в двух формах, как в hand-off'ах: `` `worker` (`verus-skills:worker` when installed as a plugin) ``;
- вызов описан как `subagent_type` = этот тип, **unnamed** (без параметра `name`) и **in the background**;
- нет ни `model: opus`, ни `general-purpose`, ни иного параметра `model`: он перекрыл бы frontmatter.

Список точек: `skills/subagent-driven-development/implementer-prompt.md`, `task-reviewer-prompt.md`, `re-review-prompt.md`, `skills/writing-plans/plan-document-reviewer-prompt.md`, `skills/plan-review/SKILL.md` (exit 3), `skills/review/SKILL.md` (exit 3 и fix wave), `skills/kickoff/SKILL.md` (Explore). Модельный раздел `subagent-driven-development/SKILL.md` («Every subagent dispatched by this skill uses `model: opus`») переписывается под типы агентов. После правки SDD и writing-plans выполняется `make repatch`.

`USING.md` и `CLAUDE.md` вместо «Subagents use `model: opus`» говорят: сабагенты запускаются как типы агентов дистро (`worker`/`reviewer`/`explorer`), модель и effort берутся из `config/models.json`, вызов — unnamed, in the background, никогда не `name`. Спека прямо фиксирует: `name:` во frontmatter агента — идентификатор типа, окна он не открывает.

### 4.5 Как переключить модель

| Что | Как |
|---|---|
| новая версия внутри семейства (Opus 5.5 → 5.6) | ничего: алиас `opus` подхватит её сам |
| другой уровень или effort у сабагентов | правка `config/models.json` → `make models`; симлинковая установка видит изменение сразу, плагин — после релиза |
| модель Codex | правка `~/.codex/config.toml` (при `default`) или `codex.model` в локальном либо репозиторном конфиге; на один прогон — `REVIEWER_CODEX_MODEL` |
| модель судьи | `judge.model` в локальном или репозиторном конфиге; на один прогон — `TYPESAFE_DEFAULT_MODEL` |

### 4.6 Компоненты

| Файл | Изменение |
|---|---|
| `config/models.json` | новый (§4.1) |
| `config/reviewer.json` | удаляется |
| `agents/{worker,reviewer,explorer}.md` | новые, frontmatter генерирует `make models` |
| `scripts/models.mjs`, `Makefile` | новые: цель `models` и валидация |
| `scripts/config.mjs` | новый: загрузка и слияние двух слоёв (`loadModels()`, `loadLocal(home?)`, `resolveCodex(env, home?)`, `resolveJudgeModel(env, home?)`, `resolveApiKey(env, home?)`) — общий модуль для судьи, `reviewer.sh` и инсталлера |
| `scripts/typesafe-judge.mjs` | модель и ключ берёт из `config.mjs`, передаёт `model` в `systemOne`, ключ — в `new TypeSafeClient({ apiKey })`; guard «нет ключа» проверяет итоговый ключ, а не только env |
| `scripts/reviewer.sh` | модель и effort Codex берёт через `node scripts/config.mjs codex`; при `default` флаг не передаётся ни в Orca-, ни в `codex exec`-ветке |
| `scripts/install.mjs` | линкует `agents/*.md` в `~/.claude/agents/` (снятие при uninstall, перенацеливание, пропуск чужих файлов — как у скиллов); проверка ключа учитывает локальный файл |
| 8 точек вызова, `USING.md`, `CLAUDE.md` | §4.4 |
| `README.md` | новый раздел «Models and effort» и раздел про ключ: `~/.verus-skills/config.json` с `chmod 600` вместо `env` в `settings.json`; env остаётся альтернативой |
| `README.md`, `docs/plugin-acceptance.md` | `rm -rf ~/.verus-skills` → `rm -f ~/.verus-skills/root` (иначе стирается ключ); в чек-лист — шаги про агентов (§5) |

### 4.7 Ошибки

- `config/models.json` битый или неполный:
  - `make models` падает с понятным сообщением и не пишет файлы;
  - судья выходит с кодом 2 — скилл спрашивает пользователя, как при недоступном судье;
  - `reviewer.sh` выходит с кодом 1.
- `~/.verus-skills/config.json` отсутствует — это нормально. Битый JSON — судья выходит с кодом 2 и называет файл, `reviewer.sh` выходит с кодом 1.
- Локальный файл с ключом доступен группе или всем (`mode & 0o077`) — судья пишет предупреждение в stderr и продолжает работу.
- Ключа нет ни в env, ни в локальном файле — прежнее поведение: exit 2, «judge unavailable».
- Файлы агентов разошлись с конфигом — падает тест.

## 5. Тестирование

1. `tests/models.test.mjs`:
   - `config/models.json` валиден;
   - три файла агентов совпадают с ним по `model`/`effort`;
   - `make models` на песочнице перегенерирует их;
   - на кривом конфиге (неизвестный effort, нет уровня, поле `apiKey`) падает, не записав ни одного файла;
   - меняются только строки `model:`/`effort:`, остальной frontmatter и тело не тронуты.
2. `tests/config.test.mjs` — приоритеты для каждого слоя на песочнице с подставным `HOME` и env:
   - env > локальный > репозиторный > default;
   - `default` у Codex не порождает флага;
   - ключ из локального файла принимается, env его перекрывает;
   - предупреждение о правах файла;
   - битый локальный JSON.
3. `tests/judge.test.mjs`: в `systemOne` уходит разрешённый `model`; ключ из локального файла доходит до клиента; guard срабатывает, только если ключа нет нигде.
4. `tests/reviewer.test.mjs`: при `default` в командной строке нет `-m` и `model_reasoning_effort`; явные значения и env передаются. Существующие тесты с `config/reviewer.json` переводятся на `models.json`.
5. `tests/patched-skills.test.mjs`:
   - в скиллах не осталось `model: opus` и `general-purpose` в точках вызова;
   - каждая из 8 точек называет свой тип агента в двух формах и содержит «unnamed» и «background»;
   - ни в одной нет параметров `name:` и `model:`.
6. `tests/install.test.mjs`: линковка, снятие, перенацеливание и пропуск чужих файлов для `agents/`; проверка ключа видит локальный файл.
7. `tests/plugin.test.mjs`: три агента на месте; при наличии бинаря `claude plugin validate` их принимает.

Ручная приёмка (добавляется в `docs/plugin-acceptance.md`):
- `claude plugin details verus-skills@verus-skills` показывает `Agents (3)`;
- вызов `verus-skills:worker` без `name` не открывает окна;
- debug-лог сессии показывает модель и effort агента из конфига;
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

### 5. Сабагенты Codex — `auto`

```
Решение (Jev): Should this change also configure the model and effort of subagents that Codex spawns when the skills run under Codex?
  A. Out of scope  99%
  B. In scope      1%
  Выбрано: A, confidence 0.99, данных 0.73 → принято автоматически
```

### 6. Сколько типов агентов — `user`

```
Решение (Jev): How many plugin agent types should the distro ship to carry model and effort for its subagents?
  A. One per role (7)   7%
  B. Three tiers        88%
  C. One generic agent  5%
  Выбрано: B, confidence 0.82, данных 0.34 → спросить пользователя (мало данных)
```

Выбрано пользователем: **три уровня** — `worker`, `reviewer`, `explorer`.

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

Сабагенты вызываются через `subagent_type`, без параметра `name` и в фоне. Это закреплено тестом (§5, п. 5) и шагом приёмки.
