# Changelog

## 2.0.0 — 2026-08-28

Волна 2.0: /plan одним инлайн-режимом, /review и /ship, мульти-машинный
пул равноправных пиров, гвард. Плюс подготовительные работы до волны.

### До волны

- Spec-пакеты в /spec [#1](https://github.com/yokeloop/yokemate/pull/1),
  SendMessage-отчёты режимов в главный чат [#2](https://github.com/yokeloop/yokemate/pull/2),
  модель запуска из паспорта проекта [#3](https://github.com/yokeloop/yokemate/pull/3)

### Команды и режимы

- `/plan` — spec, scout и grill сведены в один инлайн-режим планирования [#8](https://github.com/yokeloop/yokemate/pull/8)
- `/split plan` — явный сплит для параллельных планирований [#9](https://github.com/yokeloop/yokemate/pull/9)
- `/survey` переименован в `/review` [#6](https://github.com/yokeloop/yokemate/pull/6)
- `/settle` → `/ship`: режим докатывает тикеты до мержа — update от базы, конфликты, CI, merge, журнал [#7](https://github.com/yokeloop/yokemate/pull/7)
- Warmup-дайджест пула (очередь, папки `work/`, хвост журнала) на старте сессии, `/warmup` по требованию [#5](https://github.com/yokeloop/yokemate/pull/5)

### Мульти-машина и синк пиров

- Манифест паспортов `projects.json` + `scripts/bootstrap.sh` для подъёма новой машины [#11](https://github.com/yokeloop/yokemate/pull/11)
- Git-синк `journal/` и `knowledge/` между инстансами: автопуш после plan и финала /do, pull на старте, merge=union [#12](https://github.com/yokeloop/yokemate/pull/12)
- `pnpm adopt` — /review поднимает стенд из плана и PR-веток на машине, где /do не бежал [#13](https://github.com/yokeloop/yokemate/pull/13)
- ssh-mcp-профиль дев-сервера и сам сервер как dev-стенд (YM-99, YM-103 — HITL-тикеты без PR)

### Очередь

- Синк очереди не удаляет строки: расхождение с трекером — маркер на строке; удаление только явное — accept и новая `pnpm drop` [#4](https://github.com/yokeloop/yokemate/pull/4)

### Гвард и надёжность

- Канареечный маркер контекста в каждом ответе — деградация контекста видна сразу [#10](https://github.com/yokeloop/yokemate/pull/10)
- Гвард спрашивает подтверждение только на запуск /ship — единственный необратимый режим [#16](https://github.com/yokeloop/yokemate/pull/16)
- Имя herdr-агента батчевого /ship сворачивается в `<ключ>-plusN-ship` при переполнении 32 символов [#15](https://github.com/yokeloop/yokemate/pull/15)

### Сверка после волны

- Пост-мержевая сверка кода и промтов: guard «one agent per mode», syncPush на оба исхода accept, батчевый синк очереди, дедуп CLAUDE.md [#14](https://github.com/yokeloop/yokemate/pull/14)

## 1.0.0 — 2026-08-20

Первый срез (тег v1.0.0).
