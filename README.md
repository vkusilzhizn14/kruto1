# kruto52 — Minecraft seed finder Telegram bot

Бот для Telegram, который находит сиды Minecraft с заданными биомами и структурами рядом со
спавном. Целевая аудитория: casual игроки в RU/CIS, которые хотят красивый стартовый мир без
многочасового поиска.

## Архитектура

```
┌────────────────┐   long-poll    ┌──────────────────────┐
│ Telegram Cloud │ ◀────────────▶ │   bot (Node + TS)    │
└────────────────┘                │  • grammY            │
                                  │  • /search wizard    │
                                  │  • billing (Stars +  │
                                  │    CryptoBot)        │
                                  │  • adaptive          │
                                  │    precompute loop   │
                                  └──┬──────────┬────────┘
                                     │spawn     │SQL
                                     ▼          ▼
                          ┌──────────────┐  ┌──────────────┐
                          │ seed_worker  │  │  Postgres    │
                          │ (C / cubiomes│  │  • seed_cache│
                          │  multithread)│  │  • query_memo│
                          └──────────────┘  │  • users     │
                                            │  • ledger    │
                                            └──────────────┘
```

## Слои поиска (быстрее наверху, медленнее ниже)

1. **`query_memo`** — точный хеш-хит → миллисекунды.
2. **`seed_cache`** — битовая маска биомов/структур по 4 радиусам → ~10мс.
3. **Live C worker** — multi-thread + rarity-cascade + structure-position pre-filter
   + scale-refine 64→16→4 → секунды-минуты.

Цель: 90%+ запросов уходят в (1) или (2). Live движок — fallback.

### Что делает worker быстрым

| Приём | Где | Эффект |
|---|---|---|
| Structure-position pre-filter | `search.c` step 0 | Отсекает ≥99% сидов микросекундными вычислениями `getStructurePos` |
| Rarity-ordered cascade | `search_spec_finalize` сортирует фильтры по `rarity` | Редкий критерий рубит первым → меньше дорогих биом-проверок |
| Multi-thread | `pthread_create` × N ядер | Первый поток нашёл — все стопаются |
| Coarse→fine biome scan | `scan_biome` step=64 then step=8 | Большинство «нет такого биома» ловится грубой сеткой |
| Native build | `make native` (`-O3 -march=native -ffast-math -flto`) | ×1.3–2 на конкретном CPU |
| Pre-warmed Generator pool | один `Generator` на поток | Экономия ~0.5мс на сид |
| `mix64`-spread seeds | `util.c` | Потоки покрывают всё пространство, а не соседние сиды |
| Cooperative cancel | SIGTERM → atomic flag | Поиск останавливается мгновенно по «Отмена» |

## Стек

* **Bot**: Node 20 + TypeScript + grammY + pg + undici (для прокси)
* **Worker**: C + [cubiomes](https://github.com/Cubitect/cubiomes) (vendored как git submodule)
* **DB**: Postgres 16
* **Платежи**: Telegram Stars (нативно) + CryptoBot (USDT/TON)
* **Деплой**: Docker Compose, long-polling

## Структура репо

```
.
├── packages/
│   ├── shared/       # Каталоги биомов/структур, типы, протокол bot↔worker
│   ├── bot/          # grammY + handlers + сервисы (db, cache, billing, search)
│   └── worker/       # C-движок + cubiomes (submodule)
├── db/migrations/    # SQL миграции — применяются автоматически на старте
├── docker-compose.yml
├── .env.example
└── README.md
```

## Быстрый старт (локально)

```bash
# 0. Один раз: подтянуть cubiomes как git submodule
git submodule update --init --recursive

# 1. Скопировать .env
cp .env.example .env
# открыть .env, вписать BOT_TOKEN (получить у @BotFather)

# 2. Старт всего стека
docker compose up --build
```

Бот сразу подхватит миграции, запустит long-polling и фоновый precompute. Открой свой бот в TG → `/start`.

## Деплой на свой RU-сервер

```bash
git clone https://github.com/Drivefitzvalue/kruto52.git
cd kruto52
git submodule update --init --recursive
cp .env.example .env  # вписать BOT_TOKEN, ADMIN_USER_IDS, POSTGRES_PASSWORD
# Если нужен прокси для исходящих к Telegram:
# echo 'HTTPS_PROXY=http://user:pass@your.proxy:3128' >> .env
docker compose up -d --build
docker compose logs -f bot
```

Open `/start` в своём боте — должно прийти онбординг-сообщение.

## Окружение

См. [`.env.example`](.env.example). Минимум — `BOT_TOKEN`. Всё остальное имеет дефолты.

## Команды бота

| Команда | Что делает |
|---|---|
| `/start` | Онбординг + reply-клавиатура |
| `/search` | Запуск визарда поиска (версия → биомы → структуры → радиус → запуск) |
| `/history` | Последние 10 поисков пользователя |
| `/buy` | Покупка пакета кредитов / Pro подписки |
| `/stats` | (админ) DAU, выручка, топ-запросы |
| `/help` | Справка по флоу |

Reply-клавиатура повторяет основные действия для удобства casual-игроков:
🔍 Найти сид · ⭐️ Пресеты · 💎 Купить · 📜 История · ℹ️ Помощь.

## Тарифы

| Пак | Кредитов | Stars | USDT |
|---|---|---|---|
| Попробовать | 1 | 1 ⭐️ | $0.02 |
| Малый | 15 | 10 ⭐️ | $0.20 |
| Большой | 100 | 49 ⭐️ | $0.99 |
| Pro (30 дней безлимит) | ∞ | 30 ⭐️/мес | $0.59/мес |

Бесплатно — 2 поиска в день из кеша.

## Безопасность платежей

* Кредиты добавляются строго через `changeCredits(idempotency_key=tg_payment_charge_id)` — двойные веб-хуки безопасны.
* Каждая попытка платежа пишется в `billing_audit_log` ещё до начисления.
* Списание кредита идёт **только** после успешной выдачи сида (см. `runSearch` в `handlers/search.ts`).

## Разработка

```bash
# Установить зависимости
npm install
# Собрать worker и shared
npm run worker:build
npm run build --workspace=@kruto52/shared
# Запустить бот локально (нужен живой Postgres + .env)
npm run start --workspace=@kruto52/bot
```

Логи структурированы (pino). Уровень — `LOG_LEVEL` env (default `info`).

## Дальше (после MVP)

* `quad-constellation` поиск (4 ведьмины хижины в квадрате) как Pro-фича
* Импорт «фамозных сидов» из публичных списков (chunkbase, reddit /r/minecraftseeds)
* CryptoBot веб-хук обработчик в отдельном HTTP-сервисе
* CUDA-воркер (когда появится GPU-сервер)
* Реферальная программа
