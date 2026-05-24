# Kruto52 — Production Readiness Guide

Документ для запуска бота в прод и спокойной эксплуатации. Написано подробно, простыми словами. Если что-то непонятно — пиши и буду уточнять.

> **TL;DR**
> Бот — это Node.js + C-воркер на cubiomes + Postgres, всё в Docker Compose. На VPS с 2-4 ядрами и 4-8 ГБ ОЗУ обслужит 100 юзеров/день без напряга. Persistence уже настроен (named volume `pgdata`), бэкапы — pg_dump в cron. Дальше — подробности.

---

## Оглавление

1. [Что такое этот бот (для нового админа)](#1-что-такое-этот-бот)
2. [Что нужно ДО деплоя](#2-что-нужно-до-деплоя)
3. [Деплой шаг за шагом](#3-деплой-шаг-за-шагом)
4. [Все параметры в `.env`](#4-все-параметры-в-env)
5. [Команды и эксплуатация](#5-команды-и-эксплуатация)
6. [Бэкапы и восстановление](#6-бэкапы-и-восстановление)
7. [Мониторинг и алерты](#7-мониторинг-и-алерты)
8. [Обновление кода без потери данных](#8-обновление-кода-без-потери-данных)
9. [Известные проблемы (TODO)](#9-известные-проблемы-todo)
10. [Где могут быть пробелы / риски](#10-где-могут-быть-пробелы--риски)
11. [Что делать если упало](#11-что-делать-если-упало)

---

## 1. Что такое этот бот

**Назначение:** Telegram-бот, который ищет интересные сиды Minecraft по запрошенным критериям (биомы рядом со спавном + структуры в радиусе).

**Архитектура:**
- **`bot`** (Node.js, контейнер `kruto52-bot-1`)
  - грамма-бот через long-polling (без webhook → НЕ нужен SSL/домен/проксирующий nginx);
  - управляет состоянием пикера, очередью поисков, кредитами, билингом;
  - спавнит C-процессы для тяжёлой работы;
  - HTTP-эндпоинт `GET :8080/healthz` для мониторинга.
- **`postgres`** (контейнер `kruto52-postgres-1`, Postgres 16)
  - все данные: users, кредиты, история, кеш сидов, состояние пикера.
- **C-воркер** (`seed_worker`, `seed_precompute` — бинарники внутри контейнера `bot`)
  - использует `cubiomes` (C-библиотека Minecraft-генерации);
  - проверяет миллионы сидов в секунду на 1 ядре;
  - запускается botom как subprocess по необходимости.
- **Кеш + memo** (таблицы `seed_cache`, `query_memo`)
  - `precompute` фоном генерирует семплы сидов и сохраняет их битмаски (биомы/структуры в разных радиусах);
  - 90%+ запросов попадает в кеш и возвращается мгновенно;
  - cache miss → запускается живой `seed_worker` (на это работает семафор + очередь).

**Что важно понимать:**
- бот **не хранит** seed.dat миров пользователей или их данные Minecraft;
- единственный внешний доступ — outbound к `api.telegram.org` (443) и опционально к `pay.crypt.bot` (если включён CryptoBot);
- бот можно перезапускать без потери данных — БД отдельно в `pgdata` volume.

---

## 2. Что нужно ДО деплоя

### 2.1. Сервер (VPS)

| Размер | CPU | RAM | Диск | Рекомендация |
|---|---|---|---|---|
| **Минимум** | 2 vCPU | 4 ГБ | 20 ГБ SSD | Работает но тормозит на редких биомах |
| **Рекомендую** | 4 vCPU | 8 ГБ | 40 ГБ SSD | 100 юзеров/день со спокойствием |
| **С запасом** | 8 vCPU | 16 ГБ | 80 ГБ SSD | Если вырастешь до 1000+ юзеров/день |

**Где брать VPS:**
- **Aeza** (`aeza.net`) — РФ, дёшево (от ~500₽/мес за 2 ядра).
- **Selectel** (`selectel.ru`) — РФ, дороже но надёжнее.
- **Hetzner** (`hetzner.com`) — Германия, ~5€/мес за CX22 (2 ядра/4ГБ).
- **FirstByte** (`firstbyte.ru`) — РФ, бюджет.

Главное чтобы **исходящий 443 на `api.telegram.org`** работал без блокировки. РФ-провайдеры обычно нормально, но иногда нужен прокси (см. `HTTPS_PROXY` в `.env`).

### 2.2. ОС и софт на сервере

- **Ubuntu 22.04** или **Debian 12** (любой современный Linux подойдёт).
- **Docker Engine 24+** и **Docker Compose v2**:
  ```bash
  curl -fsSL https://get.docker.com | sudo bash
  sudo usermod -aG docker $USER && newgrp docker
  docker --version && docker compose version  # проверка
  ```
- **git** (для клонирования репо).
- **cron** (стандартный, обычно уже стоит) — для бэкапов.

### 2.3. Telegram токен

Идёшь в [@BotFather](https://t.me/BotFather), `/newbot`, получаешь токен вида `7123456789:AAA-xxxx`. Сохраняешь его, потом положишь в `.env`.

**Совет:** Создай **отдельного** бота для прода и для дев-теста. Не используй один и тот же токен на двух хостах одновременно — long-polling не поддерживает конкурентный приём update'ов.

### 2.4. Опционально: CryptoBot

Если планируешь принимать крипту — [@CryptoBot](https://t.me/CryptoBot) → `/pay` → создай магазин → выдаст `CRYPTOBOT_TOKEN` и предложит настроить webhook. Telegram Stars работают без CryptoBot.

---

## 3. Деплой шаг за шагом

### 3.1. Подготовка сервера

```bash
# зайди на сервер по ssh
ssh root@your-server-ip

# обнови систему
apt update && apt upgrade -y

# создай отдельного пользователя (не работай под root)
adduser deploy
usermod -aG sudo,docker deploy
su - deploy

# поставь docker если ещё нет
curl -fsSL https://get.docker.com | sudo bash
sudo usermod -aG docker $USER && newgrp docker
```

### 3.2. Клонирование репозитория

```bash
cd ~
git clone https://github.com/sortprawnuncouple/altzufgv.git kruto52
cd kruto52
```

### 3.3. Конфигурация `.env`

```bash
cp .env.example .env
nano .env
```

**Обязательно заполнить:**
- `BOT_TOKEN=<токен_от_BotFather>`
- `POSTGRES_PASSWORD=<любой_длинный_пароль>` — придумай сам, не должен совпадать с примером.
- `ADMIN_USER_IDS=<твой_telegram_id>` — узнай через [@userinfobot](https://t.me/userinfobot). Это даст тебе доступ к `/stats`, `/grant_credits` и т.п.

**Подобрать под размер VPS** (см. раздел 4):
- 2 vCPU / 4 ГБ:
  ```
  WORKER_THREADS=1
  LIVE_SEARCH_CONCURRENCY=1
  BOT_CPUS=1.5
  BOT_MEM=2g
  POSTGRES_CPUS=0.5
  POSTGRES_MEM=512m
  ```
- 4 vCPU / 8 ГБ:
  ```
  WORKER_THREADS=2
  LIVE_SEARCH_CONCURRENCY=2
  BOT_CPUS=3.0
  BOT_MEM=4g
  POSTGRES_CPUS=1.0
  POSTGRES_MEM=1g
  ```
- 8 vCPU / 16 ГБ:
  ```
  WORKER_THREADS=4
  LIVE_SEARCH_CONCURRENCY=2
  BOT_CPUS=6.0
  BOT_MEM=8g
  POSTGRES_CPUS=2.0
  POSTGRES_MEM=2g
  ```

### 3.4. Первый запуск

```bash
docker compose up -d --build
```

Подожди 1-2 минуты (сборка C-воркера занимает время). Потом проверь:

```bash
docker compose ps
```

Должно быть два контейнера в статусе **healthy**:
```
NAME                   STATUS
kruto52-bot-1          Up (healthy)
kruto52-postgres-1     Up (healthy)
```

Если хоть один `unhealthy` — смотри логи:
```bash
docker compose logs --tail=100 bot
docker compose logs --tail=100 postgres
```

### 3.5. Проверка работы

```bash
# health endpoint
curl http://localhost:8080/healthz
# ожидается: {"status":"ok","db":"ok","live_search":{...}}
```

Открой бота в Telegram, нажми `/start`. Должно прийти приветствие. Попробуй `/search` → выбери версию → биомы → запусти. Должен найти сид.

### 3.6. Открыть порт 8080 (опционально)

Если хочешь мониторить `/healthz` из интернета (через UptimeRobot и т.п.):
```bash
sudo ufw allow 8080/tcp
```
Но **лучше** оставить порт закрытым и мониторить локально (см. раздел 7).

---

## 4. Все параметры в `.env`

| Параметр | По умолчанию | Что делает |
|---|---|---|
| `BOT_TOKEN` | — (обязателен) | Токен от BotFather |
| `POSTGRES_PASSWORD` | `changeme_strong_password` | Пароль БД (поменяй!) |
| `DATABASE_URL` | автогенерится в compose | URL подключения к Postgres |
| `ADMIN_USER_IDS` | пусто | Telegram ID админов (через запятую) |
| `HTTPS_PROXY` | пусто | Прокси если Telegram блокирован у провайдера |
| `WORKER_THREADS` | `N_CPU/2` | Сколько потоков использует один воркер (поиск) |
| `LIVE_SEARCH_CONCURRENCY` | `N_CPU/WORKER_THREADS`, max 4 | Сколько параллельных живых поисков |
| `SEARCH_TIMEOUT_MS` | `60000` | Таймаут живого поиска (мс) |
| `SEARCH_MAX_SEEDS` | не задан = ∞ | Жёсткий лимит сидов на запрос |
| `PRECOMPUTE_ENABLED` | `true` | Запускать фоновый precompute |
| `PRECOMPUTE_INTERVAL_SEC` | `600` | Как часто кеш пополняется |
| `PRECOMPUTE_BATCH_SIZE` | `200` | Сколько сидов за один цикл |
| `FREE_DAILY_HITS` | `2` | Бесплатных поисков в день для не-Pro |
| `CRYPTOBOT_TOKEN` | пусто | Токен от CryptoBot, опционально |
| `CRYPTOBOT_WEBHOOK_SECRET` | пусто | Секрет webhook |
| `HEALTH_PORT` | `8080` | Порт `/healthz`; `0` → выключить |
| `BOT_CPUS` | `4.0` | CPU-лимит контейнера bot |
| `BOT_MEM` | `2g` | RAM-лимит контейнера bot |
| `POSTGRES_CPUS` | `1.0` | CPU-лимит Postgres |
| `POSTGRES_MEM` | `1g` | RAM-лимит Postgres |
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error` |

**Правило тюнинга:** `WORKER_THREADS × LIVE_SEARCH_CONCURRENCY ≤ N_CPU`. Иначе при пике параллельных поисков получается переподписка ядер и всё лагает.

---

## 5. Команды и эксплуатация

Всё запускается из папки `~/kruto52` (или где у тебя клон).

### 5.1. Базовые

```bash
# статус контейнеров
docker compose ps

# логи в реальном времени (Ctrl+C чтобы выйти)
docker compose logs -f bot
docker compose logs -f postgres

# логи только последние 100 строк
docker compose logs --tail=100 bot

# использование ресурсов (Ctrl+C чтобы выйти)
docker stats

# перезапуск (без потери данных)
docker compose restart bot
docker compose restart   # все

# полная остановка (БЕЗ потери данных)
docker compose down

# опасно: -v стирает volume с базой
# docker compose down -v   ← НИКОГДА не делай если не понимаешь
```

### 5.2. Команды в Telegram (юзеру)

- `/start` — приветствие + меню
- `/search` — пошаговый пикер (версия → биомы → структуры → запуск)
- `/buy` — пакеты кредитов / Pro подписка
- `/balance` — баланс кредитов + статус Pro
- `/history` — последние 10 поисков
- `/speed` — статистика последнего поиска
- `/help` — справка

### 5.3. Команды для админа (только из `ADMIN_USER_IDS`)

- `/stats` — общая статистика (юзеры/поиски/доход)
- `/admin` — справка по админ-командам
- `/grant_credits <tg_id> <amount>` — выдать кредиты юзеру
- `/revoke_credits <tg_id> <amount>` — списать
- `/set_credits <tg_id> <amount>` — установить точное значение
- `/grant_pro <tg_id> <days>` — выдать Pro на N дней
- `/revoke_pro <tg_id>` — отозвать Pro
- `/whois <tg_id>` — подробная карточка юзера

### 5.4. Подключиться к Postgres напрямую

```bash
docker exec -it kruto52-postgres-1 psql -U kruto52 -d kruto52
```

Полезные запросы (внутри `psql`):
```sql
-- количество юзеров
SELECT COUNT(*) FROM users;

-- топ юзеров по поискам
SELECT u.tg_username, COUNT(*) AS searches
  FROM search_history h JOIN users u ON u.id = h.user_id
 GROUP BY u.tg_username ORDER BY searches DESC LIMIT 20;

-- кеш-хит-рейт за сутки
SELECT source, COUNT(*) FROM search_history
 WHERE created_at > NOW() - INTERVAL '1 day' GROUP BY source;

-- сколько активных Pro
SELECT COUNT(*) FROM users WHERE pro_expires_at > NOW();

-- покинуть psql
\q
```

---

## 6. Бэкапы и восстановление

**ОЧЕНЬ ВАЖНО.** Без бэкапов один сбой = всё потеряно (юзеры, кредиты, история, кеш).

### 6.1. Настроить автоматический бэкап (cron)

Один раз на сервере:
```bash
# создать папку
sudo mkdir -p /var/backups/kruto52

# создать cron-job
sudo tee /etc/cron.d/kruto52-backup > /dev/null <<'EOF'
# Каждый день в 3:00 — дамп БД. Старше 14 дней удаляется.
0 3 * * * root docker exec kruto52-postgres-1 pg_dump -U kruto52 -Fc kruto52 > /var/backups/kruto52/db-$(date +\%F).dump && find /var/backups/kruto52/db-*.dump -mtime +14 -delete
EOF

# проверить что cron работает
sudo systemctl status cron
```

### 6.2. Off-site бэкап (рекомендую)

Локальный диск может сдохнуть вместе с сервером. Хорошо иметь копию **где-то ещё** — например S3, Backblaze B2, или просто `rsync` на другой VPS.

Простая схема через `rclone` + Backblaze B2 (дёшево):
```bash
sudo apt install rclone
rclone config   # настрой "b2" remote, потом:

# добавить в /etc/cron.d/kruto52-backup новую строку
30 3 * * * root rclone copy /var/backups/kruto52 b2:my-kruto52-bucket/db --max-age 24h
```

### 6.3. Восстановление из бэкапа

```bash
# стоп бота (чтобы не писал параллельно)
docker compose stop bot

# восстановить (NEW DB — если ставишь на чистый VPS):
docker compose up -d postgres
sleep 5
cat /var/backups/kruto52/db-2026-05-22.dump | \
  docker exec -i kruto52-postgres-1 pg_restore -U kruto52 -d kruto52 --clean --if-exists

# запустить бота обратно
docker compose start bot
```

### 6.4. Проверка что бэкапы работают

**Раз в месяц** делай тест-восстановление в отдельный контейнер. Иначе не узнаешь что бэкапы битые ровно до того момента, когда они понадобятся.

```bash
# на отдельной машине / в отдельном compose проекте
docker run -d --name pg-restore-test postgres:16-alpine
docker cp /var/backups/kruto52/db-LATEST.dump pg-restore-test:/tmp/
docker exec pg-restore-test pg_restore -U postgres -C -d postgres /tmp/db-LATEST.dump
docker exec pg-restore-test psql -U postgres -d kruto52 -c "SELECT COUNT(*) FROM users;"
docker rm -f pg-restore-test
```

---

## 7. Мониторинг и алерты

Минимум что должно быть: чтобы если бот упал — ты узнал в течение 5 минут.

### 7.1. UptimeRobot (бесплатно, рекомендую)

1. Зарегистрируйся на [uptimerobot.com](https://uptimerobot.com) (50 мониторов бесплатно).
2. Открой порт 8080 на сервере (или используй reverse-tunnel/cloudflared).
3. Создай монитор:
   - Тип: **HTTP(s)**
   - URL: `http://your-server-ip:8080/healthz`
   - Интервал: 5 минут
4. Настрой алерты в Telegram / email.

UptimeRobot будет проверять `/healthz`. Когда бот вернёт `{"status":"degraded"}` или 503 — придёт алерт.

### 7.2. Локальный watchdog без открытого порта (если 8080 закрыт)

Cron-скрипт раз в 5 минут:
```bash
sudo tee /usr/local/bin/kruto52-watchdog.sh > /dev/null <<'EOF'
#!/bin/bash
if ! curl -fsS http://localhost:8080/healthz > /dev/null; then
  curl -s -X POST "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${ALERT_CHAT_ID}&text=🚨 kruto52-bot DOWN at $(hostname)"
fi
EOF
sudo chmod +x /usr/local/bin/kruto52-watchdog.sh

# в /etc/cron.d/kruto52-watchdog:
*/5 * * * * root ALERT_BOT_TOKEN=xxx ALERT_CHAT_ID=yyy /usr/local/bin/kruto52-watchdog.sh
```

Можно завести **отдельного** мини-бота специально для алертов.

### 7.3. Метрики из `/healthz`

```json
{
  "status": "ok",
  "uptime_sec": 12345,
  "db": "ok",
  "live_search": {
    "in_flight": 1,    // сейчас идёт N поисков (≤ LIVE_SEARCH_CONCURRENCY)
    "queued": 3,       // и N в очереди ждут
    "limit": 2
  }
}
```

**Что мониторить:**
- `status: "degraded"` → есть проблема, обычно с БД.
- `queued > 5` устойчиво несколько минут → надо больше ядер или ускорить поиск.
- `uptime_sec` резко падает (например было 100000, стало 30) → бот перезапустился сам, изучи логи.

### 7.4. Системные метрики

Полезно прикрутить **netdata** или **node_exporter + prometheus + grafana**. Для 100 юзеров это overkill, но если бюджет позволяет — `netdata` ставится одной командой:
```bash
bash <(curl -Ss https://my-netdata.io/kickstart.sh)
```
Дашборд по умолчанию на `http://server:19999`. Покажет CPU, RAM, диск, сеть, docker — всё в одном.

---

## 8. Обновление кода без потери данных

**Главное:** `pgdata` — это named docker volume, он живёт ВНЕ контейнеров. `docker compose up -d --build` пересоберёт образы и перезапустит сервисы, но volume останется.

### 8.1. Обычное обновление

```bash
cd ~/kruto52
git pull
docker compose up -d --build
docker compose ps   # проверь что оба healthy
```

Миграции применяются автоматически при старте бота (`schema_migrations` идемпотентная). Новые `.sql` файлы в `db/migrations/` будут применены, старые пропущены.

### 8.2. Откат на старую версию

```bash
git log --oneline      # найди коммит к которому хочешь
git checkout <hash>
docker compose up -d --build
```

**Внимание:** если новая версия применила миграцию, которая удалила колонку — откат не вернёт данные. Перед мажорными обновлениями всегда снимай свежий бэкап:
```bash
docker exec kruto52-postgres-1 pg_dump -U kruto52 -Fc kruto52 > backup-before-upgrade.dump
```

### 8.3. Что делать если миграция упала

Лог покажет какой `.sql` файл не применился. Сценарии:
- **Синтаксическая ошибка в миграции** → откатиться на старый коммит → выпустить фикс → обновиться.
- **Конфликт с уже существующими данными** → подключиться `psql`, исправить руками, потом ручной `INSERT INTO schema_migrations(filename) VALUES('xxx.sql');` чтобы помечать её применённой.

---

## 9. Известные проблемы (TODO)

Это то что **работает** но **могло бы быть лучше**. Не блокер для прода, но в идеале допилить:

### 9.1. Высокий приоритет (стоит сделать в первую неделю)

- **[SPEED] Parameter-range pre-check для редких биомов.** Сейчас поиск pale_garden + structure делает ~30 тыс. сид/с (полный coarse-scan биом-сетки). С предварительной проверкой климат-параметров (`g_biome_para_range_*` из cubiomes) можно отбрасывать неподходящие сиды до полного скана — ускорение ×5-10. Реализация: ~1-2 часа.
- **[OPS] Off-site backups.** Сейчас только локальный pg_dump в `/var/backups`. Если сервер сгорит — всё потеряно. Добавить rclone → S3/B2 (5 минут настройки).
- **[OPS] Алерты на ошибки в логах.** Сейчас Postgres-ошибки видны только в `docker logs`. Прикрутить `loki` + `grafana-alertmanager` или хотя бы простой grep-watchdog на `level=error`.
- **[UX] Inline-кнопки для версий Minecraft.** Сейчас только 1.20 и 1.21 — после релиза 1.22 нужно будет добавить.
- **[UX] Сообщение при пустом результате с подсказкой.** Когда `findSeed` не нашёл за 60 сек, юзер видит "К сожалению, не нашёл". Полезно подсказать: "Попробуй увеличить радиус или убрать редкий биом".

### 9.2. Средний приоритет (в первый месяц)

- **[SECURITY] Rate limiting не учитывает фоновые callback'и.** Сейчас Token-Bucket на 30 запросов/мин для всех update'ов, но мощный пользователь может через автокликер залить очередь "Найти другой" и держать слот занятым. Добавить отдельный лимит на запуск поисков (например 1 поиск в 10 сек на юзера).
- **[BILLING] Webhook от CryptoBot не валидирует timestamp.** Theoretically могут replay-атаковать (сейчас защищены через `UNIQUE(provider_ref)` но это побочно). Добавить проверку `X-Crypto-Pay-Api-Signature` + nonce-window.
- **[OPS] Логи в JSON прокидываются как plain.** `pino` пишет JSON, но docker-logs не парсит как JSON. Поставить `vector` или `fluent-bit` чтобы агрегировать в loki/elastic.
- **[DB] precompute_state не растёт линейно.** Сейчас precompute хранит "with offset N мы дошли до сида X". При большом N (миллионы) запись становится мусором. Добавить TTL/чистку старых строк.
- **[FEATURE] История с фильтром и пагинацией.** Сейчас /history показывает последние 10. Хорошо бы дать "следующие 10" / поиск по фильтру.

### 9.3. Низкий приоритет (когда руки дойдут)

- **[UX] Локализация на английский.** Сейчас всё на русском. Telegram-аудитория международная.
- **[FEATURE] Экспорт результата как .seed файла Bedrock.** Сейчас только Java seed. Bedrock seeds 32-bit, кастомный формат.
- **[FEATURE] Generated render preview.** Сейчас рендерим биом-карту 256×256 png. Можно добавить 3D-preview через cubiomes_view.
- **[FEATURE] Подписка на "новые сиды по моему фильтру".** Юзер указывает критерии → бот пушит как только precompute найдёт новый матч.
- **[FEATURE] Сравнение нескольких сидов side-by-side.**

### 9.4. Технический долг

- **Тесты.** Нет unit-тестов на бот. Есть только e2e через ручное тестирование. Минимум стоит покрыть: `services/cache.ts` (cache lookup logic), `services/concurrency.ts` (семафор + очередь), `state.ts` (persist/hydrate).
- **CI.** GitHub Actions сейчас гоняет только `tsc --noEmit` + сборка C-воркера. Хорошо бы добавить запуск тестов и lint.
- **Docs.** Этот файл + README, но нет ADR (architecture decision records). Когда команда вырастет — добавить.
- **Версионирование схем.** `schema_migrations` сейчас по `filename`. При большой команде могут быть конфликты порядка. Перейти на нумерацию с временем (`20260522_001_xxx.sql`).

---

## 10. Где могут быть пробелы / риски

### 10.1. Single-VPS = single point of failure

Сейчас всё на одной машине: bot, postgres, файлы кеша. Если железо сдохнет — даунтайм до восстановления (зависит от твоей скорости).

**Митигация:**
- Бэкапы в облако (раздел 6.2).
- На втором VPS можно держать "холодный standby" с замороженной копией — но это всегда вопрос денег vs время восстановления.

### 10.2. Postgres не настроен под прод (по умолчанию)

Дефолтный конфиг postgres:16-alpine рассчитан на dev. Для прода стоит:
- увеличить `shared_buffers` до 25% RAM;
- `effective_cache_size` до 75% RAM;
- `work_mem` на ~8MB;
- включить `pg_stat_statements`.

Сейчас не делаем потому что нагрузка маленькая и дефолты пройдут. Но если вырастешь — настрой `postgresql.conf` через bind mount.

### 10.3. Long-polling vs webhook

Long-polling проще (никакого SSL/публичного домена), но имеет ограничения:
- одно подключение от одного бота → не масштабируется горизонтально.
- 100мс латентность на ответ vs мгновенно у webhook.

Для 100 юзеров/день это вообще не проблема. Если станет 10к — переключай на webhook.

### 10.4. Защита от спама не комплексная

Сейчас:
- token-bucket rate limit 30 req/min — защищает от заливания update'ами;
- семафор на live-поиски — защищает CPU.

Но:
- бесплатных хитов 2/день — можно создать 1000 аккаунтов и получить 2000 поисков (Telegram это не очень любит, но технически возможно);
- нет проверки "Telegram Premium" / возраста аккаунта.

Если станет проблемой — добавь требование `language_code` или phone-shared.

### 10.5. CryptoBot webhook доступен только при включении

Если используешь CryptoBot — webhook должен быть достижим извне. То есть надо открыть порт (например 8080 или поднять nginx + LE-сертификат). Сейчас этого в `docker-compose.yml` нет в готовом виде — настраивается отдельно. Telegram Stars работает БЕЗ webhook и достаточно для большинства кейсов.

### 10.6. Юридическое

- Если принимаешь оплату → нужны Условия использования + Политика возвратов (Telegram требует для Stars).
- Если работаешь с юзерами из РФ → персональные данные (даже tg_id и username) технически попадают под 152-ФЗ. Если делаешь публично — стоит написать **простой** privacy policy и сложить в `/help`.
- Логи могут содержать username — если будешь отдавать сторонним сервисам (loki, sentry), помни.

### 10.7. Что я НЕ тестировал на этой машине

- **Перезагрузку всего сервера** (только перезапуск контейнеров). После `reboot` Docker сам поднимет контейнеры из-за `restart: unless-stopped`, но это стоит проверить хотя бы один раз.
- **Восстановление из бэкапа на чистую машину.** Скрипт в разделе 6.3 написан корректно, но прогон не делал — обязательно прогони сам перед прод-релизом.
- **CryptoBot end-to-end оплату.** Код есть, но рабочий магазин на тестовой сети не подключал.
- **Большие нагрузки.** Стресс-теста на 50 параллельных юзеров не делал. Семафор должен справиться, но первый день в проде наблюдай за `/healthz`.

---

## 11. Что делать если упало

### 11.1. Бот не отвечает в Telegram

```bash
docker compose ps
# если что-то не healthy:
docker compose logs --tail=200 bot

# если bot падает с restart loop — посмотри что говорит:
docker compose logs bot 2>&1 | grep -i error | tail -20

# рестарт сам по себе ничего не сломает:
docker compose restart bot
```

Частые причины:
- **`BOT_TOKEN` неверный** → лог "401 Unauthorized" → проверь `.env`.
- **БД недоступна** → лог "ECONNREFUSED postgres" → перезапусти postgres.
- **Long-polling конфликт** → "409 Conflict" → у тебя ДВА экземпляра бота с одним токеном работают одновременно (например на старом сервере забыл выключить). Останови второй.

### 11.2. БД не отвечает

```bash
docker compose logs --tail=200 postgres
docker exec kruto52-postgres-1 pg_isready -U kruto52
```

- Если "FATAL: out of memory" → увеличь `POSTGRES_MEM` в `.env`.
- Если "could not open file" / corruption → восстанови из бэкапа (раздел 6.3).

### 11.3. Disk full

```bash
df -h /
docker system df   # сколько занимает docker
```

Чисти старые образы:
```bash
docker image prune -a
```

Чисти старые логи:
```bash
sudo find /var/lib/docker/containers/ -name "*.log" -mtime +30 -delete
```

### 11.4. Высокий CPU без видимых юзеров

```bash
docker stats
docker exec kruto52-bot-1 top -bn1 | head -20
```

Скорее всего precompute. Это нормально — он ест свободные циклы для пополнения кеша. Если мешает — выключи через `PRECOMPUTE_ENABLED=false` в `.env`, потом `docker compose up -d`.

### 11.5. Кто-то спамит / атакует

```bash
# найти топ-юзеров за последний час
docker exec kruto52-postgres-1 psql -U kruto52 -d kruto52 -c \
  "SELECT user_id, COUNT(*) FROM search_history WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY user_id ORDER BY 2 DESC LIMIT 10;"

# заблокировать юзера руками (через rate_limit middleware пока нет API):
docker exec -it kruto52-postgres-1 psql -U kruto52 -d kruto52 -c \
  "UPDATE users SET balance_credits = 0, pro_expires_at = NULL WHERE tg_id = <ID>;"
```

Для жёсткой блокировки на уровне бота — добавь поле `banned BOOLEAN` в `users` и фильтр в `middleware/`, либо локально в `handlers/start.ts` проверь tg_id против чёрного списка.

---

## Чеклист готовности к проду

Перед нажатием "go-live":

- [ ] VPS заведён, Docker стоит, repo склонен
- [ ] `.env` заполнен (BOT_TOKEN, POSTGRES_PASSWORD, ADMIN_USER_IDS)
- [ ] Ресурсные лимиты в `.env` соответствуют размеру VPS
- [ ] `docker compose up -d --build` → оба контейнера healthy
- [ ] `curl localhost:8080/healthz` → `status: ok`
- [ ] `/start` в Telegram отвечает приветствием
- [ ] Тестовый `/search` отрабатывает (одиночный + "найти другой")
- [ ] cron-бэкап настроен (`/etc/cron.d/kruto52-backup`)
- [ ] off-site бэкап настроен (rclone → S3/B2)
- [ ] UptimeRobot или watchdog запущен и алертит в Telegram
- [ ] Сделан **тестовый** restore из свежего бэкапа на отдельную машину
- [ ] Сохранены reservation copies: `.env` (без паролей!), `docker-compose.yml` в отдельном месте

После go-live — следи за `/healthz` первые 24 часа особенно внимательно.

---

**Если что-то непонятно — пиши, разберёмся.**
