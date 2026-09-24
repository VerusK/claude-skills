# Дизайн: внешнее ревью спеки (`spec-review`)

Дата: 2026-09-24. Статус: согласован в kickoff, уточнён по plan-review (§7).

## 1. Цель

Спека — единственный артефакт флоу, который сейчас не получает второго голоса. План проверяет `plan-review`, ветку — `review`, а спеку читает только пользователь при одобрении. Все дальнейшие шаги (`writing-plans`, `plan-review`, `review`) считают спеку эталоном: ошибка в цели, лишний scope или неверное `auto`-решение судьи тихо доходят до кода.

Новый скилл `spec-review` отдаёт спеку на внешнее ревью Codex **до** того, как пользователь её одобряет. Находки проходят тот же triage, что в `plan-review`, спека правится на месте, возможен один повторный раунд. Пользователь получает уже проверенную спеку и список решений, принятых по находкам.

## 2. Не входит

- Изменения `plan-review`, `review` и `writing-plans`.
- Ревью дизайна в bounded-пути kickoff: там нет файла спеки, дизайн живёт в чате (`skills/kickoff/SKILL.md`, раздел Paths).
- Поднятие версии: релизы делаются отдельно через `make release` (версия `1.0.0` не менялась с прошлых фич).
- Web-поиск в промпте ревьюера (Aside в gstack). Codex отвечает из своих знаний; проверка «нет ли встроенного решения» делается без поиска.

## 3. Установленные факты

- `skills/kickoff/SKILL.md`, architectural-путь: шаг 3 пишет `docs/specs/YYYY-MM-DD-<topic>-design.md` (Goal, Non-goals, Design, Testing, Decisions с пометками `auto`/`user`), шаг 4 — self-review, шаг 5 — коммит и просьба об одобрении, шаг 6 — на одобрение вызвать `writing-plans`.
- `skills/plan-review/SKILL.md`: §0 входы, §1 сборка промпта, §2 запуск `reviewer.sh` (коды 0/3/1, запасной `verus-reviewer`), §3 triage («How should … be fixed?», 2–4 реальных варианта, `accepted without the judge`), §4 правка и раздел `## Plan review decisions (round N)`, §5 второй раунд, §6 передача и закрытие сессии.
- `skills/plan-review/reviewer.md` адаптирован из gstack `plan-eng-review` (`NOTICE`), но без его Step 0 Scope Challenge. Исходник отслеживается как watch-only (`sources.yaml`: `gstack-plan-eng-review`).
- Тесты-контракты, которые перечисляют скиллы или места вызова: `tests/plugin.test.mjs` (список из 10 скиллов), `tests/patched-skills.test.mjs` (`HANDOFFS`, `DISPATCH_SITES` — 8 мест, шаблон сессии), `tests/triage.test.mjs` (правила triage для `review` и `plan-review`), `tests/reviewer.test.mjs` (маркер конца отчёта в каждом `reviewer.md`), `tests/locator.test.mjs` (локатор одинаков в трёх скиллах).
- Раздел Decisions спеки ничем не парсится: grep по `scripts/`, `tests/`, `skills/` находит только текст kickoff.

## 4. Дизайн

### 4.1 Компоненты

- **Новые файлы:** `skills/spec-review/SKILL.md` (оркестрация по образцу `plan-review`) и `skills/spec-review/reviewer.md` (промпт ревьюера, §4.3).
- **`skills/kickoff/SKILL.md`, architectural-путь:** шаг 5 — «Commit the spec and invoke `spec-review` (`verus-skills:spec-review` when installed as a plugin) with the spec path». Шаг 6 (передача на `writing-plans`) переезжает в `spec-review`. Bounded- и spike-пути не меняются. Self-review (шаг 4) остаётся до коммита.
- **Документация:**
  - `USING.md`: во флоу новый шаг 2 `spec-review` между `kickoff` и `writing-plans`; правило — «Never skip `spec-review`, `plan-review` or `review`».
  - `README.md`: mermaid-схема, ASCII-схема, таблица шагов, таблица скиллов (`spec-review` — own, методология из gstack `plan-eng-review`).
  - `NOTICE`: `spec-review` в списке собственных скиллов; методология gstack адаптирована также в `spec-review/reviewer.md`.
  - `agents/verus-reviewer.md`: `spec-review` в списке вызывающих скиллов.
  - Строки `description` в `.claude-plugin/plugin.json` и `.codex-plugin/plugin.json` упоминают ревью спеки.

### 4.2 Поток `spec-review`

- **§0 Входы.** `SPEC` — аргумент, иначе самый новый `docs/specs/*-design.md`; нет файла — стоп с сообщением. `REPORT` — `<каталог SPEC>/<basename SPEC без .md>.review.md`, репо-относительный. `ROUND` = 1. Локатор репо и протокол судьи — как в `plan-review` (из `skills/kickoff/judge.md`, имя скилла `spec-review`).
- **§1 Промпт** (временный файл в `$TMPDIR`), по порядку: текст `reviewer.md`; `THE SPEC:` и спека дословно в fence длиннее любой серии бэктиков в ней; `Referenced source files:` — то же правило, что в `plan-review` (path-подобные токены с `/`, `test -f`, без `.claude/`, `.codex/`, `agents/`, `node_modules/`, не больше 40); во втором раунде — `Previous report:` из `<REPORT>.round1.md` и строка «Only report findings that are still present after the spec changes; mark fixed ones as resolved.»; последней строкой `Write the report to <REPORT>` с той же самопроверкой `tail -1`.
- **§2 Запуск.** `reviewer.sh --prompt-file … --output "$REPORT" --title spec-review --timeout-min 15 --session-file "$SESSION"`, где `SESSION="$(git rev-parse --show-toplevel)/.context/spec-review-$(basename "$ROUND1_REPORT" .md)-session"`; в первом раунде сначала `--close-session` сироты. Коды выхода — как в `plan-review`: `0` отчёт готов; `3` запасной ревьюер (`verus-reviewer` в Claude Code, `spawn_agent` в Codex, без имени, в фоне, без модели; на хосте без сабагентов ревью делается в этой сессии с пометкой в заголовке отчёта, что это не независимый голос); `1` и прочие — починить вызов, дальше не идти.
- **§3 Triage.** Разбирается `## Findings (confidence 7+)` по убыванию серьёзности, по правилам `plan-review`: одна разумная правка — `accepted without the judge: <finding one-liner> — <the evidence…>`; иначе вопрос судье «How should … be fixed?» с 2–4 реальными вариантами, «leave it as is» только с сильнейшим аргументом. `facts` судьи: Goal спеки, находка дословно, фрагмент спеки, факт из репо. **Правило для решений:** находка, которая спорит с решением из раздела Decisions, помеченным `user`, не идёт к судье — это вопрос пользователю с вариантами и рекомендацией. Находка против решения `auto` проходит обычный triage. Каждый decision block печатается в чате сразу.
- **§4 Правка спеки.** Выбранное действие каждой находки (принятое судьёй, пользователем или без судьи) вносится прямо в разделы спеки. В конец спеки дописывается `## Spec review decisions (round N)`: decision block на каждую судимую находку, строка `accepted without the judge: …`, строка `Left as is: <finding> — <argument>`. Раздел Decisions не трогается. Коммит `docs(spec): apply spec-review round N`.
- **§5 Второй раунд** — правило `plan-review`: пропустить, если в первом отчёте нет P0/P1 с уверенностью 7+; иначе, если спека изменилась, сохранить отчёт в `<REPORT>.round1.md`, пересобрать промпт, перезапустить с той же `SESSION`, снова triage и правка. Не больше двух раундов.
- **§6 Передача.** Закрыть сессию ревьюера. Сводка пользователю: сколько раундов, какой путь ревьюера, сколько находок принято/оставлено/спрошено, путь отчёта (и `.round1.md`, если был второй раунд). Затем: «Spec written and reviewed: `<SPEC>`. Review it; when approved I will write the plan with `writing-plans`.» Ждать явного одобрения, на одобрение вызвать `writing-plans` (`verus-skills:writing-plans` when installed as a plugin). Больше ничего не вызывать. При запуске вне kickoff поведение то же.
- **Правила скилла:** никогда не начинать реализацию; не редактировать `REPORT`; один повторный раунд максимум; при любом выходе сначала `reviewer.sh --close-session "$SESSION"`.

### 4.3 Промпт ревьюера (`skills/spec-review/reviewer.md`)

Тот же каркас, что у `plan-review/reviewer.md`: запрет читать `~/.codex/`, `~/.agents/`, `.codex/skills/`, `.claude/`, `agents/`; роль — senior engineer, ревьюит design doc до планирования; «Problems only»; ни один раздел не пропускается, пустой — «No issues found». Разделы:

0. **Scope challenge** (из gstack Step 0, без интерактива — итог это находки, а не остановка):
   - какой существующий код уже решает подзадачи, можно ли переиспользовать его вместо параллельного;
   - минимальный набор изменений, достигающий цели; что можно отложить;
   - сложность: 8+ файлов или 2+ новых сервиса/класса — повод предложить меньший вариант;
   - самописное решение там, где есть встроенное в рантайме или фреймворке;
   - полная версия против среза: срез, экономящий минуты, — находка;
   - новый артефакт (бинарь, пакет, контейнер, воркфлоу) без сборки и дистрибуции в спеке — находка.
1. **Requirements:** пропуски, противоречия между разделами, требования с двумя толкованиями, плейсхолдеры.
2. **Scope:** Non-goals полны и не противоречат Design; спека укладывается в один план.
3. **Feasibility и сбои:** каждое утверждение спеки о существующих файлах, интерфейсах и поведении сверяется с кодом репо (перечисленные файлы читаются напрямую); для каждой новой точки интеграции — один реалистичный сбой и покрывает ли его дизайн.
4. **Testability:** у каждого требования есть способ проверки в разделе Testing.
5. **Decisions:** каждое решение с пометкой `auto` сверяется с фактами репо; находка указывает вопрос решения и его пометку (`auto`/`user`), чтобы triage применил правило §4.2.

Калибровка уверенности 1–10 и формат находки — как в `plan-review`: `[P0|P1|P2|P3] (confidence: N/10) <spec section or file:line> — <what is wrong> — <what to do instead>`. P0 = спека в таком виде нереализуема или не достигает своей цели; P1 = приведёт к переделке плана или кода; P2 = стоит поправить до плана; P3 = желательно. Отчёт:

```
# Spec review: <spec title>
## Verdict
<CLEAR | NEEDS CHANGES> — one sentence.
## Findings (confidence 7+)
## Appendix (confidence below 7)
## Section notes
### 0. Scope challenge
### 1. Requirements
### 2. Scope
### 3. Feasibility
### 4. Testability
### 5. Decisions
<!-- end of review -->
```

Последняя строка отчёта — `<!-- end of review -->`, один раз. Ревьюер не правит спеку и другие файлы, не запускает тесты и сборку, не печатает отчёт в stdout.

### 4.4 Ошибки

- Спека не найдена — стоп с сообщением, ревьюер не запускается.
- Промпт не прошёл самопроверку последней строки — пересобрать, не запускать.
- `reviewer.sh` вернул `1` или другой код — починить вызов, не продолжать; незакрытый терминал Orca закрывается в §6.
- Судья недоступен (`judge_exit` ≠ 0) — вопрос пользователю со строкой `TypeSafe judge unavailable: …`.
- Хост без сабагентов при коде `3` — ревью в этой сессии, пометка в заголовке отчёта.

## 5. Тестирование

Контрактные тесты на `node:test`, `npm test` зелёный:

- `tests/plugin.test.mjs`: список скиллов — 11, с `spec-review`.
- `tests/patched-skills.test.mjs`:
  - `HANDOFFS`: `kickoff/SKILL.md → spec-review`, `spec-review/SKILL.md → writing-plans` (с плагинной формой); пара `kickoff/SKILL.md → writing-plans` удаляется, `kickoff → test-driven-development` остаётся.
  - `DISPATCH_SITES`: `spec-review/SKILL.md: ["reviewer"]`, итого 9 мест.
  - Тест сессий: `spec-review/SKILL.md` с шаблоном `.context/spec-review-$(basename "$ROUND1_REPORT" .md)-session`, закрытие в §6 и правило «Whenever this skill stops».
- `tests/triage.test.mjs`: проверки §3 и §4 распространяются на `spec-review/SKILL.md`; новый тест — §3 `spec-review` направляет находки против `user`-решений пользователю мимо судьи, а §4 пишет `## Spec review decisions (round N)`.
- `tests/reviewer.test.mjs`: маркер конца отчёта проверяется и в `spec-review/reviewer.md`.
- `tests/locator.test.mjs`: локатор одинаков в четырёх скиллах.
- Новый тест: `spec-review/reviewer.md` содержит разделы 0–5 из §4.3 в этом порядке.
- `USING.md` и `README.md` называют `spec-review` между `kickoff` и `writing-plans`.

Приёмка вручную после реализации: прогнать `spec-review` на этой спеке и убедиться, что отчёт появился рядом с ней, раздел `## Spec review decisions (round 1)` дописан, после одобрения вызывается `writing-plans`.

## 6. Решения

### 1. Подход — `auto` (kickoff 2026-09-23)

```
Решение (Jev): approach for adding a spec review step
  A. New skills/spec-review modeled on plan-review: own design-document reviewer prompt, findings judged, controller revises the spec in place, one re-review; plan-review untouched  89%
  Выбрано: A, confidence 0.83, данных 0.64 → принято автоматически
```

Блок восстановлен по записи прошлой сессии: сохранились только выбранный вариант и числа, остальные варианты не записаны.

### 2. Место во флоу — `auto` (kickoff 2026-09-23)

```
Решение (Jev): where in the flow spec-review runs
  A. kickoff runs it after writing/committing the spec and BEFORE asking the user to approve it  98%
  Выбрано: A, confidence 0.97, данных 0.60 → принято автоматически
```

Блок восстановлен по записи прошлой сессии: сохранились только выбранный вариант и числа, остальные варианты не записаны.

### 3. Где применяется — без судьи

Только architectural-путь: это единственный путь, который пишет файл спеки (`skills/kickoff/SKILL.md`, Paths, шаг 3); bounded-дизайн существует только в чате. Второго реального варианта нет.

### 4. Что проверяет промпт ревьюера — `auto`

```
Решение (Jev): What should the spec-review reviewer prompt (skills/spec-review/reviewer.md) evaluate?
  A. Design-document sections     100%
  B. plan-review's four sections  0%
  C. Consistency only             0%
  Рекомендация Claude: A
  Данных достаточно: 81%
  Выбрано: A, confidence 1.00, данных 0.81, порог 0.7/0.6 → принято автоматически
```

### 5. Находки против записанных решений — `user`

```
Решение (Jev): How should spec-review handle reviewer findings that contradict a decision recorded in the spec's Decisions section?
  A. By origin        93%
  B. All to the user  7%
  C. Out of scope     0%
  Рекомендация Claude: A
  Данных достаточно: 50%
  Выбрано: A, confidence 0.89, данных 0.50, порог 0.7/0.6 → спросить пользователя (мало данных)
```

Пользователь выбрал **A**: против `auto` — обычный triage, против `user` — вопрос пользователю без судьи.

### 6. Когда второй раунд — `auto`

```
Решение (Jev): When should spec-review run its one re-review round?
  A. Same rule as plan-review  100%
  B. Any change                0%
  Рекомендация Claude: A
  Данных достаточно: 79%
  Выбрано: A, confidence 1.00, данных 0.79, порог 0.7/0.6 → принято автоматически
```

### 7. Где лежит отчёт — `auto`

```
Решение (Jev): Where should spec-review write the reviewer's report?
  A. Beside the spec  96%
  B. docs/reviews/    4%
  Рекомендация Claude: A
  Данных достаточно: 63%
  Выбрано: A, confidence 0.93, данных 0.63, порог 0.7/0.6 → принято автоматически
```

### 8. Куда записываются решения по находкам — `user`

```
Решение (Jev): How should spec-review record its triage decisions in the spec?
  A. Separate section  88%
  B. Into Decisions    12%
  Рекомендация Claude: A
  Данных достаточно: 44%
  Выбрано: A, confidence 0.76, данных 0.44, порог 0.7/0.6 → спросить пользователя (мало данных)
```

Пользователь выбрал **A**: отдельный раздел `## Spec review decisions (round N)`.

### 9. Кто держит одобрение и передачу на `writing-plans` — `auto`

```
Решение (Jev): Which skill should own the user-approval gate and the hand-off to writing-plans once spec-review exists?
  A. spec-review owns it  85%
  B. kickoff keeps it     15%
  Рекомендация Claude: A
  Данных достаточно: 75%
  Выбрано: A, confidence 0.700, данных 0.75, порог 0.7/0.6 → принято автоматически
```

### 10. Промпт gstack `plan-eng-review` — `user`

Вопрос пользователя: брать ли промпт gstack, который он раньше запускал на спеках. Пользователь согласился с предложением: добавить раздел 0 «Scope challenge» из gstack Step 0 (переиспользование, минимальный набор, сложность, встроенное вместо самописного, полнота, дистрибуция) в виде находок без интерактива и пункт о сбое на каждую новую интеграцию в Feasibility; не брать интерактивные гейты, web-поиск через Aside, `TODOS.md`, brain и разделы Code quality/Performance уровня кода.

## 7. Изменения по plan-review (раунд 1)

Ревью плана (`docs/plans/2026-09-24-spec-review.review.md`) изменило дизайн. Решения записаны в плане, раздел `Plan review decisions (round 1)`.

- **§0:** путь спеки из аргумента нормализуется в путь относительно репозитория, поэтому абсолютный путь и `../` работают. Стоп, если файла нет, он вне git или вне репозитория (`reviewer.sh:39` отвергает абсолютный `--output`).
- **§4:** если в отчёте нет находок с уверенностью 7+, раздел `Spec review decisions` не дописывается и коммита нет (`auto`).
- **§6:** если пользователь при одобрении просит правки, затрагивающие Goal, Non-goals, Design или Decisions, и второй раунд ещё не был, он запускается на изменённой спеке. Иначе вопрос об одобрении перечисляет правки, которых ревьюер не видел (`auto`).
- **`scripts/reviewer.sh`** (выбор пользователя, снимает прежний Non-goal): путь `codex exec` принимает отчёт только с маркером `<!-- end of review -->`, как путь Orca. Отчёт без маркера переносится в `.context/<title>-partial.md`, лаунчер выходит с `3`. Это закрывает дыру и в `plan-review`, и в `review`.
- **Приёмка** (выбор пользователя): шесть ручных сценариев с ожидаемым результатом (нет спеки, абсолютный путь, семь бэктиков, нет Decisions, находка против `user`-решения, правки при одобрении). Результаты пишутся в `docs/plans/2026-09-24-spec-review.acceptance.md`.
