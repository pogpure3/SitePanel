# Журнал работ

История работ по проекту и по стенду: что просили, что нашли, что изменили, чем проверили.
Новые записи — сверху. Формат и обязательные требования — в [AGENTS.md](AGENTS.md).

Связанные документы: [CHANGELOG.md](CHANGELOG.md) — изменения поведения самой панели,
[README.md](README.md) — описание возможностей.

---

## 2026-10-20 — Сайт api-progression (apitest.evil-mesh.ru) на panel_test + поддержка deploy/-layout

**Запрос.** «Добавь сайт с доменом apitest.evil-mesh.ru из репо
github.com/pogpure3/api-progression на тестовый стенд». Учётные данные админки
панели пользователь прислал в чате (логин `admin`, пароль *** — в auth.json
фактический логин `admin`, «Admin» не сработал).

**Диагностика.**
- Репозиторий **приватный** (404 без авторизации); локальный `gh` авторизован
  как pogpure3 — токен для клона получен через `gh auth token` (***, в WORKLOG
  маскируется, на стенд передан через временный файл /tmp с shred после).
- Проект: Node ≥ 22.5 (`node:sqlite`), ноль npm-зависимостей, порт из
  `process.env.PORT` (дефолт 7011), SQLite в `deploy/data` (volume compose).
  На стенде Node 20 → как plain node невозможен; задуман под Docker.
- **Layout: Dockerfile и docker-compose.yml лежат в подкаталоге `deploy/`**
  с build-контекстом на КОРЕНЬ репо (`context: ..`) — вчерашний docker-флейвор
  панели искал Docker-файлы только в корне сайта.
- DNS `apitest.evil-mesh.ru` → 46.29.164.250 (panel_test) уже настроено.
- Шаблон домена на стенде: nginx-вхост (80→301, 443→прокси 127.0.0.1:8080,
  certbot `--nginx`), TLS терминирует nginx — как у pqr.

**Изменения — код панели** (коммит ниже):
- `src/sites/manager.js`: поддержка deploy/-layout — `detectDockerFlavor`
  ищет compose/Dockerfile в корне И в `deploy/` (приоритет корня); новый
  `dockerfileRel`; `composeMainFile` возвращает относительный путь
  ('deploy/docker-compose.yml') — он идёт в `-f` и в путь override-файла;
  `dockerBuild` для compose использует `composeBaseArgs` (пара -f), для
  Dockerfile из deploy/ — `docker build -f deploy/Dockerfile .` (контекст —
  корень сайта). Контейнеры compose-флейвора ищутся по label
  `com.docker.compose.project=sitepanel-<id>` (`composeContainerIds`) —
  пользовательский `container_name` (у api-progression — `pumping-api`)
  делает поиск по имени непригодным (монитор/стоп/удаление). PRESERVED_DIRS
  (`deploy/data`, `data`): каталоги данных копируются из .backup после свапа —
  SQLite-база переживает передеплои.
- **Баг, найденный на живом деплое**: строки портов compose с хвостовым
  комментарием (`- "7011:7011"   # тот же порт, что у fox-report`) не
  матчились regex'ом → containerPort сваливался в дефолт 3000 → публикация
  10000:3000 при приложении на 7011. Фикс: `(\s+#.*)?` в regex; регрессионный
  тест добавлен. (Попутно замечено: docker-proxy принимает TCP до мёртвого
  бэкенда, поэтому waitListening прошёл — статус running при мёртвом порту;
  реальную недоступность ловит HTTP health-check монитора.)
- `tests/docker-sites.test.js`: юнит-тесты deploy/-layout (детект, порты,
  приоритет корня), интеграционный тест точного layout'а репозитория
  (deploy/Dockerfile+compose с context '..', перенос deploy/data через
  обновление).

**Изменения — panel_test.**
- Код: бэкап `/root/sitepanel-code-backup-20261020-012913.tar.gz`, заменены
  `src/sites/manager.js`, `tests/docker-sites.test.js`, рестарт (два раза:
  до и после фикса regex).
- Сайт: `POST /api/sites/git` (url, branch main, токен gh, autoStart) → сайт
  `3ac49e2f0d64` «api-progression», тип docker/compose, порт 10000,
  containerPort 7011 (после фикса; первый деплой ушёл с 3000 — исправлен
  PATCH containerPort=null + update-git). Домен apitest.evil-mesh.ru привязан
  в панели. Сгенерирован `deploy/docker-compose.yml.sitepanel-override.yml`
  (публикация `127.0.0.1:10000:7011`, сервис pumping-api).
- Nginx: вхост `/etc/nginx/sites-available/apitest` (+symlink в enabled):
  staged :80 → certbot certonly --nginx → полный (80→301, 443→8080 с
  Upgrade-заголовками, по шаблону pqr-panel); копия `/root/apitest.nginx.bak.*`;
  `nginx -t` ok до обоих reload. Сертификат Let's Encrypt apitest.evil-mesh.ru
  (ECDSA, до 2027-01-17), продление — certbot (authenticator nginx).

**Проверка.**
- Код: локально 8 тестов файла — 5 pass / 3 skip (docker на Windows-машине
  нет); на стенде до фикса 8/8, после фикса — см. ниже; lint чистый.
- Сайт: панель — status running, health up (200, 9 мс), containerPort 7011,
  домен привязан; docker ps: `pumping-api 127.0.0.1:10000->7011 Up`.
- Извне: `http://apitest.evil-mesh.ru` → 301 https; https → 200 (кабинет),
  ssl verify 0; `GET /api/word/biglist?token=***&server_name=test&minWords=2&maxWords=3`
  → 200 «no data for these settings» (база слов пуста — импорта ещё не было);
  без токена → 401. Соседи не задеты: pqr 200, panel login 200.
- Данные кабинета: первый вход — логин admin@local, пароль *** (сгенерирован
  приложением, взят из docker logs; база пересоздана до чистой, т.к. пароль
  первого контейнера был утерян при recreate). API-токен приложения — ***.

**Осталось.**
- Импорт базы слов/URL в кабинет приложения — пользователем через UI кабинета.
- PUBLIC_BASE_URL кабинета не задан (ссылки собираются как localhost) —
  задать в кабинете (public_base_url) или добавить env в override.
- Обновления сайта — кнопкой «Обновить из Git» в панели (токен сохранён в
  db.json, 0600). База deploy/data переживёт обновление (PRESERVED_DIRS).
- Код панели (deploy/-layout) на panel_beget не выкладывался (там нет docker,
  изменения обратно совместимы) — уедет со следующей полной выкладкой.

## 2026-10-20 — Docker-сайты: деплой проектов через Dockerfile и docker-compose.yml

**Запрос.** «Добавь возможность добавлять сайты-проекты в панель через
Dockerfile + docker-compose.yml». Уточнено: поддерживать оба формата
(Dockerfile и compose), источники — zip и Git.

**Диагностика.** Разведка по всем местам, где тип сайта (`node`/`static`)
имеет значение (детект, деплой, старт/стоп, монитор, прокси, UI, тесты):
- `detectType` (manager.js) проверял package.json — dockerized node-проект
  определился бы как node; Dockerfile/compose нужно проверять раньше.
- `finalizeDeploy` выдавал порт только node-сайтам.
- `httpserver.route()` fallthrough: неизвестный тип уходил в `serveStatic` —
  каталог docker-сайта (Dockerfile, исходники, секреты) УТЕК бы как статика.
- Остановка: `ensurePortFreed` видит `docker-proxy` как чужой процесс
  (cmdline-эвристика не совпадает) — убивать им нельзя; kill docker CLI не
  останавливает контейнер. Нужен явный `docker stop`/`compose stop`.
- Контейнер переживает панель: `boot()` мог бы двоить; `adoptOrphans` уже
  скипал не-node; при остановке панели docker-сайты не глушим (restart policy).
- Монитор: docker-тип попадал в else → health всегда down; stats невозможны
  (нет child-процесса).

**Изменения.**
- `src/store.js`: `SITE_TYPES` + `docker`; поля `containerPort` (int|null,
  мусор обнуляется) и `dockerFlavor` (`dockerfile`|`compose`|null); `validateSite`
  экспортирована (была) — тесты зовут напрямую.
- `src/sites/manager.js`: блок «Docker-сайты» — `detectDockerFlavor`,
  `detectContainerPort` (EXPOSE / короткий `ports` compose; длинный синтаксис
  не парсим), `dockerProjectName/ImageName` (`sitepanel-<id>`),
  `dockerRunLogged` (runCommand: лог в sitelog, таймаут), `execDockerQuiet`
  (inspect/version без лога), `dockerContainerExists/Running`,
  `assertDockerAvailable` (внятная ошибка без docker), `dockerBuild`,
  `dockerRunCmd` (`docker run -d --restart unless-stopped -p 127.0.0.1:<port>:<cp>
  -e PORT/<HOST>/SITE_ID`), `writeComposeOverride` + `composeBaseArgs`
  (см. «найдено» ниже), `dockerRecreate`, `dockerRemoveAll` (down --rmi local
  --volumes с fallback по label / rm -f + rmi). `detectType` — docker раньше
  package.json. `finalizeDeploy`: порт для docker, containerPort
  (пользователь → EXPOSE/ports → 3000), после свапа: override →
  assertDockerAvailable → build → recreate (ошибка билда → штатный откат
  .backup). `_startDocker`/`_stopDocker` (ветки в `_start`/`_stop`; stop —
  явный docker/compose stop + waitPortFree, БЕЗ ensurePortFreed).
  `_rollback`/`_restoreBackup` для docker: build + recreate (docker start
  поднял бы контейнер со старым образом). `_removeSite`: dockerRemoveAll.
  `waitListening`: node|docker. Экспорты detectType/detectDockerFlavor/
  detectContainerPort/composeFirstService/dockerContainerRunning/
  dockerProjectName.
- `src/monitor.js`: HTTP-проверка для docker (как node) + сверка
  `dockerContainerRunning`: статус running при мёртвом контейнере → crashed.
- `src/httpserver.js`: `route()` и WS-upgrade — docker проксируется как node.
- `src/config.js`: `PANEL_DOCKER_BUILD_TIMEOUT_MIN` (10 мин).
- `src/admin/routes.js`: `serializeSite` + containerPort/dockerFlavor; PATCH
  `/api/sites/:id` принимает `containerPort` (int 1..65535|null, иначе 400);
  литералы создаваемых сайтов с полями.
- `src/admin/public/app.js`: `typeLabel` (Docker в бейджах списка, карточки,
  toast); строка «Порт контейнера» в Обзоре (только для docker, правка кликом
  → PATCH); `index.html`: хинт формы добавления про Dockerfile/compose.
- `tests/docker-sites.test.js` — НОВЫЙ: юнит (приоритет детекта, 4 имени
  compose-файлов, EXPOSE/ports, длинный синтаксис → null, composeFirstService,
  валидация полей) + интеграция с реальным docker (скипается без CLI):
  полный цикл Dockerfile-сайта (деплой → прокси → stop/start → обновление с
  пересборкой → удаление с чисткой контейнера и образа) и compose-проект.
- README (раздел «Docker-проект» в требованиях к сайтам, env-таблица),
  CHANGELOG (Добавлено).

**Найдено при отладке (фиксы до первого зелёного прогона).**
- Обновление dockerfile-сайта: build создавал новый образ, но `_startDocker`
  делал `docker start` СТАРОГО контейнера — v2 не проявлялась. Фикс: recreate
  после билда в деплой-пути.
- compose-проект без `ports` не публикует порт — прокси не достучался. Фикс:
  панель генерирует `<compose-файл>.sitepanel-override.yml` в каталоге сайта
  (`ports: !override ["127.0.0.1:<port>:<cp>"]` для ПЕРВОГО сервиса — публиковать
  всем сервисам (БД) было бы дырой; `!override` заменяет пользовательский ports,
  наружные публикации в обход панели невозможны); все compose-команды — с явной
  парой `-f <main> -f <override>`; override перезаписывается при деплое/старте
  (если потерялся).

**Выкладка — panel_test.** Бэкап кода ДО:
`/root/sitepanel-code-backup-20261019-233940.tar.gz`. Заменены 9 файлов
(src/config.js, src/store.js, src/sites/manager.js, src/monitor.js,
src/httpserver.js, src/admin/routes.js, src/admin/public/app.js,
src/admin/public/index.html, tests/docker-sites.test.js); `node --check` всех;
md5 manager.js и теста совпали; `systemctl restart sitepanel` → active.

**Проверка.**
- Локально: lint чистый; полный набор 218 тестов — 200 pass, 3 fail
  (предсозданные Windows-сбои T-32/T-43/T-44, на чистом дереве те же),
  docker-интеграции корректно скипнулись (docker на Windows-машине нет).
- На стенде: `tests/docker-sites.test.js` — **6 pass / 0 fail** (интеграции с
  реальным docker). Полный набор: **219 тестов — 214 pass, 0 fail, 5 skip,
  exit 0** (первый прогон упал на необновлённом manager.js — см. «найдено»;
  после фиксов зелёный). Обрывы ssh во время проверок (Connection reset) —
  сетевые, на стенд не влияли; перезапуски прогонов.
- Смоук UI в браузере (scratch-панель 3295 на стенде, туннель, NO_AUTH):
  деплой zip с Dockerfile через API → карточка «Тип: Docker-контейнер»,
  «Порт контейнера: 3000 → 127.0.0.1:14000 ✎», health ok; PATCH containerPort
  (валидное → 200, мусор → 400); скриншот снят. Смоук-хозяйство удалено
  (панель, контейнер, образ, temp).
- Остатки отладки на стенде вычищены (зависшие диагностические панели убиты,
  контейнеры/образы `sitepanel-*` удалены, temp-каталоги снесены); основная
  панель active без перерывов, pqr работает.

**Осталось.**
- На panel_beget Docker НЕ ставился — docker-сайты там заработают после
  установки docker (функция в коде уже есть после следующей полной выкладки).
- Панель в Docker-контейнере (deploy/) НЕ может управлять docker-сайтами
  (нет docker CLI/socka внутри образа) — при таком способе развёртывания
  панели docker-деплой отключить или пробросить /var/run/docker.sock
  (осознанно не делали).
- compose: поддержан короткий синтаксис `ports` и верхнеуровневые файлы без
  `includes`; длинный YAML-синтаксис публикуется только через containerPort
  пользователя.

## 2026-10-19 — Docker на panel_test + первая сборка образа sitepanel

**Запрос.** «Установи докер на тестовый стенд» — установка Docker на panel_test
и (естественное продолжение, заявлено в «Осталось» записи про deploy-файлы)
первая реальная сборка образа `sitepanel`.

**Диагностика.** Ubuntu 24.04.4 LTS (noble), `systemd-detect-virt` → kvm,
x86_64, `/` 20G (7.3G занято) — установка возможна; docker не стоял; UFW
active (22/80/443), 7.1-усиление активно, панель в systemd.

**Изменения — panel_test.**
- Официальный apt-репозиторий Docker: `/etc/apt/keyrings/docker.asc`
  (ключ download.docker.com), `/etc/apt/sources.list.d/docker.list`
  (`deb [arch=amd64 signed-by=...] https://download.docker.com/linux/ubuntu noble stable`)
  — файлы новые, существовавшие sources не менялись.
- Установлены `docker-ce`, `docker-ce-cli`, `containerd.io`,
  `docker-buildx-plugin`, `docker-compose-plugin` (apt, noninteractive).
- Смоук-контейнер `sitepanel-smoke` создан, проверен и **удален**; образ
  `hello-world` удалён; **остался образ `sitepanel:latest` (~300 МБ)**.
- На стенд дополнительно выложены `deploy/Dockerfile`,
  `deploy/docker-compose.yml` (md5 совпадает с локальным) и `.dockerignore`
  — в `/opt/sitepanel/` для сборки.

**Изменения — репозиторий** (коммит ниже): в `deploy/docker-compose.yml`
добавлен `PANEL_ADMIN_HOST: 0.0.0.0` — **дефект, найденный при подготовке
смоука**: панель по умолчанию биндит админку на 127.0.0.1 (`src/config.js`
adminHost), published-порт контейнера до неё не доставал. Наружу хоста админка
не светит: `ports` публикует только `127.0.0.1:3000`. README дополнен
пояснением; CHANGELOG — секция «Инфраструктура стенда».

**Проверка.**
- Установка: `docker --version` → 29.9.1; `docker compose version` → v5.6.0;
  сервис active + enabled.
- Docker Hub доступен без зеркал: `docker pull hello-world` → ok.
- Сборка: `docker build -f deploy/Dockerfile -t sitepanel:latest /opt/sitepanel`
  — успешно (npm ci, ~2 мин).
- Смоук-контейнер: `docker run -d --cap-add NET_BIND_SERVICE -e
  PANEL_ADMIN_HOST=0.0.0.0 -e PANEL_ADMIN_PORT=3101 -e PANEL_HTTP_PORT=18080
  -e PANEL_HTTPS_PORT=18443 -p 127.0.0.1:3101:3101 sitepanel:latest`:
  `/healthz` → `{"ok":true}`; `/login` → 200; `docker exec whoami` → **node**
  (не root); пароль первого запуска напечатан в `docker logs` (значение в
  журнал не переносилось); прокси-порт 18080 отвечает из сети docker
  (HTTP/1.1 404 — штатная заглушка на чужой Host); `/app/data` наполнился
  (auth.json, sites, certs, logs, backups) — права записи под `node` работают.
- Стенд не пострадал: sitepanel active (аптайм непрерывный), `pqr` через
  прокси → 301, UFW active, цепочка `DOCKER-USER` создана, диск 8.3G/20G.

**Осталось.**
- **Docker и UFW**: опубликованные (`-p`) порты контейнеров обрабатываются
  iptables-цепочками Docker в обход правил UFW INPUT — перед публикацией
  порта наружу помнить, что UFW его не прикроет. Сейчас наружу не опубликовано
  ничего (смоук был только на 127.0.0.1).
- На panel_beget Docker НЕ ставился. Образ `sitepanel:latest` на тестовом
  стенде — остаток смоука; удалить, если будет мешать (`docker rmi sitepanel:latest`).

## 2026-10-19 — Деплой-файлы: deploy/Dockerfile + deploy/docker-compose.yml

**Запрос.** «Добавь Деплой: deploy/Dockerfile + docker-compose.yml» — Docker-развёртывание панели.

**Диагностика.**
- `package.json`: `node-pty` — в `optionalDependencies` (нативный модуль), прочие
  зависимости чистый JS; `engines: node >=20` → база `node:22-alpine`.
  `npm ci --omit=dev --omit=optional` даёт установку без компилятора.
- Веб-терминал (`src/admin/terminal.js`): без node-pty fallback — `script -qfc`,
  в alpine `script` входит в `util-linux` (добавлен apk-пакетом).
- Healthcheck-эндпоинт `/healthz` существует и не требует авторизации
  (`src/index.js`), Node 22 умеет `fetch` — HEALTHCHECK без curl в образе.
- Порты по умолчанию из `src/config.js`: 80/443/3000 — совпадают с EXPOSE и
  `ports` compose; `PANEL_DATA_DIR=/app/data` — том `panel-data`.
- Docker отсутствует и локально, и на panel_beget/panel_test
  (`docker --version` — нет) — сборка образа в этой задаче не выполнялась.

**Изменения.**
- `deploy/Dockerfile` — НОВЫЙ: node:22-alpine; `apk add util-linux` (для
  `script`); слой зависимостей `npm ci --omit=dev --omit=optional` (кэш сборки
  не инвалидируется кодом); `COPY src ./src`; `PANEL_DATA_DIR=/app/data`;
  `mkdir data && chown node:node` (named volume наследует владельца при первой
  инициализации); `USER node`; EXPOSE 80/443/3000; HEALTHCHECK на `/healthz`;
  CMD `node src/index.js`.
- `deploy/docker-compose.yml` — НОВЫЙ: build context `..` + dockerfile
  `deploy/Dockerfile`; `restart: unless-stopped`; `cap_add: NET_BIND_SERVICE`
  (80/443 под пользователем node без root); `ports` 80, 443 и админка только на
  `127.0.0.1:3000`; env `TZ=Europe/Moscow`, `PANEL_LE_EMAIL`,
  `PANEL_LE_STAGING` (пробрасываются из окружения); том `panel-data:/app/data`.
- `.dockerignore` — НОВЫЙ: node_modules, data (секреты), tests, scripts, .git,
  .github, .vps, .zcode, .design-audit, *.md; каталог deploy НЕ исключён
  (legacy-билдер требует Dockerfile внутри контекста).
- `README.md`: раздел «Запуск в Docker» (порты, том, пароль из
  `docker logs sitepanel`, cap NET_BIND_SERVICE, терминал в режиме `script`).
- `CHANGELOG.md`: [Unreleased] → Добавлено.
- Стенды не трогались (панель там живёт в systemd, docker на них не ставился).

**Проверка.**
- Проверено: YAML compose валиден (`npx js-yaml deploy/docker-compose.yml`
  — без ошибок); соответствие портов/env дефолтам `src/config.js`;
  `package-lock.json` присутствует (`npm ci` работоспособен).
- Не проверено (честно): сборка образа и запуск контейнера — Docker недоступен
  ни локально, ни на стендах. Первую реальную сборку стоит прогонять командой
  `docker compose -f deploy/docker-compose.yml up -d --build` и смотреть
  `docker logs sitepanel` (пароль админа) + `curl /healthz`.

**Осталось.** Пробная сборка образа, когда появится Docker (локально или на
стенде); при желании — CI-шаг `docker build` в `.github/workflows/ci.yml`.

## 2026-10-19 — Выкладка плановых бэкапов на прод panel_beget

**Запрос.** «Установи на прод» — выкладка функции плановых бэкапов (коммит
1a78a99, см. запись выше от 2026-10-19) на panel_beget.

**Диагностика.** Стенд доступен, sitepanel active (аптайм с ребута 2026-10-14),
node v22.22.1 (требованиям >= 20 удовлетворяет), сайты `88b1b76605e9` (pg+p) и
`3ebc4e88346e` (m) на месте. Найдено расхождение с AGENTS.md: **фактический
hostname прода — `yyxrrbytkl`, а не `yblrhcoxcd`** (IP верный: 141.133.197.43,
содержимое /opt/sitepanel/data/sites совпадает; видимо, изменён провайдером).
AGENTS.md не правил — уточнить у пользователя при случае.

**Изменения — panel_beget.** Бэкап кода ДО:
`/root/sitepanel-code-backup-20261019-221257.tar.gz` (tar src tests package.json
из `/opt/sitepanel`, 347 133 байт). Заменены те же 9 файлов, что и на panel_test:
`src/config.js`, `src/store.js`, `src/index.js`, `src/sites/backups.js` (новый),
`src/sites/manager.js`, `src/admin/routes.js`, `src/admin/public/app.js`,
`src/admin/public/index.html`, `tests/backups.test.js` (новый). Промежуточный
каталог .deploy-tmp создавался и удалён (стейджинг не понадобился — scp прямо
в финальные пути). `node --check` 8 js-файлов — без ошибок; md5 backups.js /
app.js / manager.js / index.html — совпадают с локальными. `npm install` не
требовался (новых зависимостей нет). `systemctl restart sitepanel` → active
(22:13:46 по журналу стенда, МСК). Каталог `data/backups/` создан при старте
панели (ensureDirs).

**Проверка.**
- Локально на проде: `/healthz` → `{"ok":true}`; `/login` → 200; `/api/system`
  без пароля → 401; через прокси панели: `pg` → 301, `p` → 301 (редирект на
  HTTPS), `m` → 401 (штатная Basic самого MeshCentral).
- Извне: `beget.evil-mesh.ru/login` → 200, `/healthz` → 200, `pg.evil-mesh.ru`
  → 200, `p.evil-mesh.ru` → 200, `m.evil-mesh.ru` → 401. Сайты поднялись сразу,
  паузы 502/503 после рестарта не наблюдалось.
- `node --test tests/backups.test.js` на проде: **9 pass, 0 fail**.
- Полный набор на проде (`node tests/run.js`): **213 тестов — 208 pass,
  0 fail, 5 skip, exit 0** (совпадает с результатом panel_test).

**Осталось.**
- Расписания бэкапов на прод-сайтах (pg, m) НЕ включены — по умолчанию функция
  выключена для каждого сайта; включается в карточке сайта («Бэкапы» →
  «Расписание»), это решение администратора.
- Хостнейм прода в AGENTS.md (`yblrhcoxcd`) разошёлся с фактическим
  (`yyxrrbytkl`) — поправить после подтверждения пользователем.
- Прежние позиции не изменились: этап 5 (изоляция прав), внешние хранилища
  бэкапов (S3/FTP).

## 2026-10-19 — Плановые бэкапы сайтов (по образцу ispmanager); выкладка на panel_test

**Запрос.** «Используй https://github.com/morluto/rea и скопируй функции
https://www.ispmanager.com/about в нашу панель, тестировать можно на тестовом
стенде». После уточнения объёма пользователь выбрал: только **плановые бэкапы**
(без cron-планировщика и расширений файл-менеджера), хранение — **локально на
сервере** + скачивание zip.

**Диагностика.**
- REA (`morluto/rea`) — CLI/MCP «reverse engineer anything» (`rea-agents` 6.7.0,
  npm, MIT). `npx rea-agents doctor`: node 24.21.0 и win32 healthy; движки
  Hopper/Ghidra/IDA/JADX отсутствуют — для анализа сайтов не нужны. Полный
  MCP-сетап (`npx rea-agents setup`) пишет в `~/.zcode/cli/config.json` и требует
  перезапуска клиента — НЕ выполнялся; использован CLI-режим через npx.
  Захвачены HAR публичных страниц ispmanager.com (`/about`, `/backups`) через
  Playwright-chromium; `npx rea-agents inspect-web-network-capture backups.har har`
  разобрал захват (43 записи, HTTP 200) — подтверждена схема бэкапов ispmanager:
  полный + дифференциальный по расписанию, ротация, восстановление из панели,
  хранилища локально/FTP/Dropbox/S3/Google Drive. Демо-панель ispmanager — за
  формой с email; регистрация не выполнялась. Копировались только идеи функций,
  код и тексты ispmanager не использовались.
- Файловый менеджер в панели уже есть (`src/admin/routes.js`, секция
  «Файловый менеджер»: list/read/write/mkdir/rename/delete/upload+extract) —
  эта функция ispmanager в панели была. PHP-версии, DNS (нужен BIND), локальные
  MySQL/PostgreSQL и конфиг веб-сервера к Node-панели неприменимы. Из
  применимого отсутствовали плановые бэкапы: был только бэкап прошлого деплоя
  (`<id>.backup`) с откатом одной кнопкой.
- `src/sites/lock.js`: повторный вход в `withSiteLock` отклоняется — поэтому
  восстановление (нужны внутренние `_stop`/`_start`) реализовано в
  `src/sites/manager.js`, а не в отдельном модуле.

**Изменения.**
- `src/config.js`: `backupsDir` (`data/backups`), `backupsEnabled`
  (`PANEL_BACKUPS`, по умолчанию 1), `backupCheckSec` (`PANEL_BACKUP_CHECK_SEC`,
  60), `backupMaxSiteMb` (`PANEL_BACKUP_MAX_MB`, 512); каталог добавлен в
  `ensureDirs()`.
- `src/store.js`: `validateSite()` — дефолт и коэрция `site.backupSchedule`
  `{enabled:false, intervalHours:24, keep:5, lastRunAt:null, lastError:null}`
  (интервал 0.05..8760 ч, keep 1..100); без bump версии схемы.
- `src/sites/backups.js` — НОВЫЙ: `createBackup` (zip каталога сайта под
  `withSiteLock`; `node_modules` и симлинки отсекаются; лимит
  `PANEL_BACKUP_MAX_MB`; проверка свободного места (`fs.statfs`, при недоступности
  проверка пропускается); запись во временный файл в `data/tmp` + rename;
  sidecar-метаданные `<имя>.zip.json`), `listBackups` (с диска), `deleteBackup`,
  `prune`, `removeAll`, `summary`, `normalizeScheduleInput`, планировщик
  `start()/tick()/dueSites()` — первый тик сразу после старта, затем раз в
  `PANEL_BACKUP_CHECK_SEC`; защита от постановки дублей (`RUNNING` set); ошибка
  планового бэкапа → `lastError` + Telegram-алерт через `alerts.send`.
- `src/sites/manager.js`: `_restoreBackup` + `restoreBackup` (экспорт): стоп
  сайта → распаковка `extractZip` (та же защита от zip-бомб/zip-slip, что при
  деплое) в staging `data/tmp/restore-*` → двухшаговая подмена каталога
  (`<id>.restore-old`, как в `_rollback`, P-20) → `detectType` → для node-сайтов
  `npmInstall` (node_modules в бэкапе нет) → старт; при неудаче распаковки/подмены
  сайт возвращается в прежнее состояние.
- `src/index.js`: `backups.start()` после `manager.boot()` (рядом с
  `alerts.start()`); выключатель — внутри `backups.start()`.
- `src/admin/routes.js`: секция «Бэкапы» — `GET /api/sites/:id/backups`,
  `PUT /api/sites/:id/backups/schedule`, `POST /api/sites/:id/backups`,
  `POST /api/sites/:id/backups/:name/restore`, `GET .../download`,
  `DELETE .../:name`; `serializeSite` отдаёт `backupSchedule`; сайтам при
  создании проставляется дефолт расписания; `DELETE /api/sites/:id` удаляет и
  `data/backups/<id>` (`backups.removeAll`). Имена бэкапов валидируются
  `^\d{8}-\d{6}\.zip$` (400 на мусор, 404 на несуществующий).
- UI: `src/admin/public/app.js` — карточка «Бэкапы» в карточке сайта
  (состояние расписания, последний бэкап, `lastError`), страница
  `#/sites/:id/backups` (таблица: метка/размер/триггер/дата; кнопки создать /
  скачать / восстановить с подтверждением / удалить с подтверждением), модалка
  расписания; hash-роутинг, CRUMBS, syncShell, patchDetail.
  `src/admin/public/index.html` — модалка `#backupModal` (role=dialog,
  aria-modal). `style.css` не менялся (переиспользованы `.panel`, `.fm-table`,
  `.fm-bar`, `.badge`).
- `tests/backups.test.js` — НОВЫЙ: 9 тестов (ручной бэкап+sidecar+скачивание,
  восстановление статики и node-сайта с переустановкой зависимостей, ротация
  keep=2, валидация расписания и имён, планировщик с `PANEL_BACKUP_CHECK_SEC=1`,
  `PANEL_BACKUPS=0`, удаление бэкапов с сайтом, юнит `dueSites`).
- Документация: `README.md` (возможности, API-таблица, env, каталог data/),
  `CHANGELOG.md` ([Unreleased] → Добавлено).
- Новых npm-зависимостей нет (adm-zip уже в стеке).

**Выкладка — panel_test.** Бэкап кода ДО:
`/root/sitepanel-code-backup-20261019-204335.tar.gz` (tar src tests package.json
из `/opt/sitepanel`). Заменены 9 файлов: `src/config.js`, `src/store.js`,
`src/index.js`, `src/sites/backups.js` (новый), `src/sites/manager.js`,
`src/admin/routes.js`, `src/admin/public/app.js`,
`src/admin/public/index.html`, `tests/backups.test.js` (новый). `node --check`
всех 8 js — без ошибок; md5 `backups.js`/`app.js` локально и на стенде совпали.
`npm install` не требовался. `systemctl restart sitepanel` → active.
Примечание: во время проверки (~20:52 МСК) SSH-сессии к стенду оборвались
(`Connection reset by peer`), переподключение прошло без последствий — сбой
сетевой, стенд не перезагружался (аптайм процессов непрерывный).

**Проверка.**
- Локально (Windows): `npm run lint` — чисто; `npm test`: 213 тестов — 197 pass,
  3 fail, 13 skip. Все 3 падения — предсуществующие сбои Windows-окружения
  (T-32, T-43, T-44), воспроизводятся на чистом дереве 4be6bda (`git stash` →
  тот же результат) и не связаны с задачей. `tests/ui.test.js` +
  `tests/ui-browser.test.js` (Playwright, реальный браузер): 12 pass.
- На стенде: `/healthz` → `{"ok":true}`; `/login` → 200; `/api/system` без
  пароля → 401; `pqr.evil-mesh.ru` через прокси → 301 (редирект на HTTPS).
  `node --test tests/backups.test.js` на стенде: **9 pass, 0 fail**.
- UI в браузере (черновой экземпляр панели на стенде: `PANEL_NO_AUTH=1`,
  админ-порт 3190, `PANEL_DATA_DIR=/tmp/sp-ui-selftest`, `PANEL_BACKUP_CHECK_SEC=1`,
  доступ через `ssh -L 13190`; инстанс и каталог снесены после проверки):
  карточка «Бэкапы» на месте; «Создать сейчас» → бэкап 249 Б, «Последний бэкап»
  в карточке; страница бэкапов: таблица с триггером «Вручную» и ссылками;
  модалка расписания: включено, интервал 1 ч, хранить 3 — сохранилось;
  восстановление по «↩» с диалогом подтверждения → «Восстановлено из бэкапа»,
  сайт вернулся в «Работает»; скриншот снят, вёрстка в стиле панели.
- Полный набор на стенде (`node tests/run.js`): **213 тестов — 208 pass,
  0 fail, 5 skip, exit 0** (baseline до задачи: 196 тестов, 191 pass, 5 skip).

**Осталось.**
- На panel_beget (продакт-стенд) функция НЕ выкладывалась — по условию задачи
  тестировали на panel_test; выкладка на прод — отдельным решением.
- Регистрация REA как MCP-сервера в ZCode (`npx rea-agents setup`, правка
  `~/.zcode/cli/config.json` + перезапуск клиента) — по желанию, отдельно.
- Бэкапы пишутся на тот же диск, что и `data/`: от полного затирания при
  отказе диска не спасают; внешние хранилища (S3/FTP, как в ispmanager) —
  потенциальное развитие.

## 2026-10-14 — Перезагрузка panel_beget: загружено ядро 7.0.0-38

**Запрос.** «Перезагружай продакт» — ребут panel_beget, ждавший нового ядра
(`/var/run/reboot-required`).

**Состояние до.** Работало ядро 7.0.0-31-generic, установлено 7.0.0-38.38
(`linux-image-generic`); аптайм 2 дня 6 ч. Автозапуск: sitepanel, nginx,
fail2ban, ufw — enabled; **`ssh.service` disabled — SSH держит
socket-активация** (`ssh.socket` enabled/active, Listen 0.0.0.0:22,
триггерит ssh.service) — доступ после ребута подтверждён. Swap 2 ГиБ
(`/swapfile`, в fstab).

**Изменения — panel_beget.** `reboot` через SSH (17:22 МСК по журналу стенда;
время стенда МСК). Прочего не менялось. Нюанс: в первой проверочной команде
после ребута лишний раз выполнен `systemctl restart sitepanel` — панель
стартовала дважды (17:22:41 автостарт загрузки, 17:23:23 рестарт), на
результат не повлияло; сайты при этом стартуют заметно дольше админки.

**Проверка.** Сервер вернулся через ~1 мин; `uname -r` → **7.0.0-38-generic**;
`systemctl --failed` — пусто; sitepanel/nginx/fail2ban/ufw — active; swap
2.0 ГиБ; jail `sshd` работает (0 banned после ребута); локальный
`/healthz` → 200. Внешне (после дозревания node-процессов сайтов, порты
10000/10001 слушаются): `pg.evil-mesh.ru` → 200, `p.evil-mesh.ru` → 200,
`m.evil-mesh.ru` → 401 (штатная Basic MeshCentral), `beget.evil-mesh.ru/login`
→ 200, `/healthz` → 200. Сразу после ребута сайты давали 502/503 — nginx
отвечал раньше, чем поднимались node-процессы; через ~1 мин всё сошлось.

**Осталось.** Оба стенда на актуальных ядрах. Из несогласованного по плану —
только этап 5 (изоляция прав A-04).

---

## 2026-10-14 — Перезагрузка panel_test: загружено ядро 6.8.0-147

**Запрос.** «Можешь перезагрузить сервер» — ребут panel_test, ждавший нового
ядра (заметка apt из записи о 7.1 выше).

**Состояние до.** Ядро на диске 6.8.0-147.147 (`linux-image-generic`), работало
6.8.0-139-generic; аптайм 19 дней. Автозапуск проверен до ребута: sitepanel,
nginx, fail2ban, ufw, ssh — все `enabled`.

**Изменения — panel_test.** `reboot` через SSH (≈13:16 МСК / 10:16 UTC —
время стенда UTC; пре-чек `uptime` в 10:14:42 UTC). Прочего не менялось.

**Проверка.** Сервер вернулся через ~1–2 мин; новое подключение по ключу.
`uname -r` → **6.8.0-147-generic**; `systemctl --failed` — пусто;
sitepanel/nginx/fail2ban/ufw — active; swap 2.0 ГиБ поднялся из fstab;
jail `sshd` работает (счётчики после ребута обнулены: 1 failed / 0 banned);
`http://127.0.0.1:3100/healthz` → 200; извне `pqr.evil-mesh.ru` → 200
(сайт автозапустился), `panel.evil-mesh.ru/login` → 200, `/healthz` → 200.

**Осталось.**

- **panel_beget тоже ждёт перезагрузки** (`/var/run/reboot-required`,
  работает ядро 7.0.0-31-generic) — продакт с живыми pg/m, ребут только по
  команде пользователя в подходящее окно.

---

## 2026-10-14 — 7.1: усиление panel_test (sshd только по ключу, fail2ban, swap)

**Запрос.** «Делай 7.1» — применение ранбука `scripts/harden-old-stand.sh`
(задача 7.1 / I-04 плана, требовала явного согласия пользователя, получено).

**Диагностика — состояние до (проверено по SSH).**

- sshd: `sshd -T` → `permitrootlogin yes`, `passwordauthentication yes`;
  в `/etc/ssh/sshd_config.d/` лежали `50-cloud-init.conf`
  (`PasswordAuthentication yes`) и `60-cloudimg-settings.conf` (`no`) —
  ловушка «первого значения» актуальна, файл усиления обязан называться
  `01-…`.
- UFW **уже был активен**: default deny incoming / allow outgoing, правила
  22/80/443 (v4+v6) — шаг UFW ранбука свёлся к идемпотентному повторению.
- fail2ban: не установлен (`is-active` → inactive, dpkg пуст).
- swap: 0 (RAM 1.9 Ги).
- Слушатели: 22 (sshd), 80/443 (nginx), 51820 (nginx `stub_status` из
  `/etc/nginx/conf.d/stub_status_nginx-ui.conf` — снаружи уже закрыт UFW),
  loopback 3100 (админка панели), 9000 (nginx-ui), 53 (resolved); на всех
  интерфейсах 8080/8443 (прокси панели) и 10001 (сайт pqr) — снаружи закрыты
  UFW, наружу нужны только 22/80/443.
- Вход по ключу подтверждён ДО правок: `ssh -o PasswordAuthentication=no
  panel_test 'echo KEY-OK'` → KEY-OK; алиас: root@46.29.164.250:22, ключ
  `~/.ssh/sitepanel_vps` (единственный в `authorized_keys`,
  `sitepanel-vps-46.29.164.250`).
- На время работ поднята контрольная вторая сессия (фоновый ssh `sleep 1800`),
  остановлена после всех проверок.

**Изменения — panel_test.**

- `/etc/ssh/sshd_config.d/01-hardening.conf` (новый): `PermitRootLogin
  prohibit-password`, `PasswordAuthentication no`, `PubkeyAuthentication yes`.
  Бэкап: `/etc/ssh/sshd_config.bak.20261014-093227` (время стенда, UTC;
  12:32 МСК). `sshd -t` успешен, `systemctl reload ssh` применён.
- `/swapfile` 2 ГиБ (fallocate, 600, mkswap, swapon), строка в `/etc/fstab`
  (бэкап ДО правки — исправлен порядок ранбука: `bak` вызывался после
  добавления строки), `/etc/sysctl.d/99-sitepanel.conf`
  (`vm.swappiness=10`, `vm.vfs_cache_pressure=50`), `sysctl --system`
  применён. Бэкап: `/etc/fstab.bak.20261014-093227`.
- fail2ban 1.0.2-3ubuntu0.1 установлен, `systemctl enable --now`, jail `sshd`
  активен (backend systemd journal). Прямо на применение: **banned 3 IP,
  257 failed** — брутфорс идёт постоянно.
- Попутно: мёртвый PPA `certbot/certbot` отключён — у PPA нет Release для
  noble, `apt-get update` падал с ошибкой и из-за `&&` в ранбуке блокировал
  установку fail2ban. certbot 2.9.0 стоит из noble/universe, PPA ничего не
  поставляет. Бэкап: `/etc/apt/sources.list.d/certbot-ubuntu-certbot-noble.sources.bak.20261014-123421`,
  файл переименован в `…sources.disabled`. `apt-get update` теперь чистый.
- `scripts/harden-old-stand.sh` (в репо): исправлен порядок бэкапа fstab,
  шаг `apt-get update` сделан нефатальным, заголовок переведён в статус
  «применён» с нюансами.

**Проверка.**

- Новое подключение с `PasswordAuthentication=no` → успех; `sshd -T`:
  `permitrootlogin without-password`, `passwordauthentication no`,
  `pubkeyauthentication yes`, `kbdinteractiveauthentication no`.
- `systemctl is-active`: sitepanel/nginx/ufw/fail2ban — active.
- `free -h`: Swap 2.0Gi; `swapon --show` — `/swapfile` prio -2;
  `sysctl` — 10 и 50.
- `nginx -t` — syntax ok, test successful.
- Извне: `pqr.evil-mesh.ru` → 200, `panel.evil-mesh.ru/login` → 200,
  `/healthz` → 200.
- Отметка apt (не действие): ядро ждёт перезагрузки («Restarting the system to
  load the new kernel…») — ребут не делался, вне задачи.

**Осталось.**

- Этап 5 (изоляция прав A-04) — последний несогласованный пункт плана.
- Перезагрузка стенда для нового ядра — на усмотрение пользователя (окно
  обслуживания).

---

## 2026-10-14 — Выкладка на прод panel_beget: мобильные карточки списка сайтов

**Запрос.** «Отправляй на прод» — перенос правки 1141a08 (мобильный список
сайтов: карточки, поля в столбец) с panel_test на panel_beget.

**Состояние до.** md5 файлов на beget совпадали с до-правочным состоянием
рабочей копии (8338bba): app.js `99acf8b79949974c5ecf4c9b9e16219c`, style.css
`4981669b4ba1e20f2a10c96ecf937a22` — прод был на ожидаемом коде, правкой не
затронут.

**Изменения — panel_beget.**

- Бэкап ДО: `/root/app.js.bak.20261014-122323` (88168 байт) и
  `/root/style.css.bak.20261014-122323` (27657 байт); откат — `cp` обратно в
  `/opt/sitepanel/src/admin/public/`, рестарт не нужен.
- `scp` двух файлов в `/opt/sitepanel/src/admin/public/`: app.js
  `b40259d97758a85cae8c305e0bf332f8`, style.css
  `a9ab28e64198ff913ce7fdaa6f7d95de` — совпадают с рабочей копией и panel_test
  (три стороны). Рестарт не требовался (статика с диска), nginx не менялся.

**Проверка.**

- На стенде: `systemctl is-active` = active; локальный `curl
  http://127.0.0.1:3100/healthz` → 200.
- Извне: `beget.evil-mesh.ru/login` → 200, `beget.evil-mesh.ru/healthz` → 200;
  сайты не затронуты — `pg.evil-mesh.ru` → 200, `m.evil-mesh.ru` → 401
  (штатная Basic MeshCentral). Содержимое закрытых ассетов без сессии не
  отдаётся (401) — соответствие сверено по md5 на диске.

**Осталось.** Оба стенда снова на одном коде (1141a08 + журналы). Из
несогласованного: 7.1 (усиление panel_test), этап 5 (изоляция прав).

---

## 2026-10-14 — Мобильный список сайтов: карточка с полями в столбец

**Запрос.** «Поправь отображение сайтов в мобильной версии, информацию о сайте
в виджете сайта выводи в столбец» — со скриншотом телефона: в таблице сайтов
на panel.evil-mesh.ru колонка «Сайт» сжата, бейджи Let's Encrypt/RAM переносятся
по буквам, колонки «Обновлён»/«Действия» ушли за край экрана.

**Диагностика.** `.sites-table` имеет `min-width: 640px`
(`src/admin/public/style.css:420`), `.table-card` — `overflow-x: auto`; на
экране ~390px таблица не сжимается ниже 640px, поэтому горизонтальный скролл и
расплющенная первая колонка. На мобильных брейкпоинтах (900px/760px) таблица
не переустраивалась вовсе.

**Изменения — код панели.**

- `src/admin/public/style.css` — новый блок `@media (max-width: 640px)` после
  секции «Список сайтов»: таблица переводится в блочный режим (`display:block`
  для table/tbody/tr/td), `thead` скрывается, каждая строка становится
  карточкой (паддинг 14px 16px, разделитель между карточками), поля сайта
  идут в столбец; подписи полей (ДОМЕНЫ/ПАМЯТЬ/ОБНОВЛЁН) — через
  `td::before { content: attr(data-label) }` в стиле заголовка таблицы;
  `.cell-dim` — `white-space: normal` + `overflow-wrap: anywhere` (длинные
  домены переносятся); `.row-actions` — перенос и выравнивание влево; поиск в
  `.list-bar` растягивается на всю ширину. Десктоп (>640px) не затронут.
- `src/admin/public/app.js` — в `siteRowHtml()` ячейкам `cell-domains`,
  `cell-mem`, `cell-updated` добавлены атрибуты `data-label` («Домены»,
  «Память», «Обновлён») — источник подписей для мобильной раскладки. Логика
  `patchRow`/фильтра не менялась (скрытие отфильтрованных строк через inline
  `display:none` работает и при блочном display).

**Проверка.**

- `npm test`: 204 теста — 188 pass / 3 fail, все три —
  `tests/durability.test.js` (T-32 ECONNRESET, T-43, T-44), падают так же и на
  чистом чекауте 8338bba (сетевые/тайминговые, к правке не относятся).
  `tests/ui.test.js` + `tests/ui-browser.test.js` — 12/12 pass. eslint — 0 ошибок.
- Изолированный экземпляр (тестовый helper `tests/helpers/panel.js`,
  PANEL_NO_AUTH, сайт `pqr` с доменом `pqr.evil-mesh.ru`), Playwright chromium,
  вьюпорт 390×844, темы light и dark: `scrollWidth == innerWidth == 390`
  (горизонтального скролла нет), ошибок консоли нет; в карточке поля в столбец
  с подписями, кнопки видимы. Скриншоты: `.design-audit/mobile-sites-light.png`,
  `.design-audit/mobile-sites-dark.png`. Контроль десктопа 1280×800 — таблица
  с шапкой без изменений (`.design-audit/desktop-sites-check.png`).

**Выкладка — panel_test.**

- `scp` двух файлов в `/opt/sitepanel/src/admin/public/` (app.js, style.css);
  md5 локально и на стенде совпадают: app.js
  `b40259d97758a85cae8c305e0bf332f8`, style.css
  `a9ab28e64198ff913ce7fdaa6f7d95de`. Рестарт не требовался (статика отдаётся с
  диска, `express.static` ревалидирует по ETag); `systemctl is-active` = active.
- Внешне: `https://panel.evil-mesh.ru/login` → 200, `/healthz` → 200; контент
  закрытых ассетов без сессии не отдаётся (401) — сверка по md5 на диске.
- На panel_beget попадёт при следующей полной выкладке.

**Осталось.**

- Предсуществующие падения `durability.test.js` (T-32/T-43/T-44) на рабочей
  машине — вне этой задачи; на стендах набор зелёный (199 pass / 0 fail на
  beget по записи от 2026-10-14).
- Редизайн-задолженность из предыдущих записей: 7.1 (усиление panel_test),
  этап 5 (изоляция прав), выкладка на panel_beget.

---

## 2026-10-14 — Выкладка на прод panel_beget: редизайн, степперы порогов, страница входа

**Запрос.** «Делай сейчас» — перенос на panel_beget всего, что до этого выкладывалось
только на panel_test: редизайн админки (f2f9fd8), степперы порогов (3069ac0),
страница авторизации с сессиями (1cc36ba).

**Состояние до.** Код beget оставался на состоянии этапов 3-7 (bd0e4c7): в
`src/admin/public/` три файла, терминала и тем не было. Вхост
`/etc/nginx/sites-available/beget-admin` уже содержал `proxy_http_version 1.1` +
`Upgrade`/`Connection "upgrade"` — nginx НЕ менялся.

**Выкладка.**

- Бэкап кода ДО: `/root/sitepanel-code-backup-20261014-010828.tar.gz` (57 файлов);
  md5 `data/db.json` и `data/auth.json` зафиксированы до замены, каталог данных
  не трогался.
- Заменены `src/` (31 файл), `tests/` (25), `package.json`, `package-lock.json`,
  `eslint.config.js`, документы. `npm install --omit=dev`: `ws` 8.22.0;
  **node-pty 1.1.0 собрался** — на этом стенде терминал работает в полном
  PTY-режиме (в отличие от panel_test, где нет g++ и действует fallback `script`).
  Синтаксис 26 .js проверен до рестарта; `systemctl restart sitepanel` → active.

**Проверка.**

- Локально после рестарта: `/healthz` ok; `GET /login` 200; `GET /login.js` 200;
  `GET /` (html) → `302 /login?next=%2F`; `/api/system` и `POST /api/terminal/token`
  без пароля → 401; в журнале «Веб-терминал: ws-апгрейд на порту 3100».
- Сайты через прокси: `pg`/`p` → 301 (SSL-редирект, штатно), `m` → 401
  (Basic самого MeshCentral, штатно). Внешне: `beget.evil-mesh.ru/login` → 200,
  `pg.evil-mesh.ru` → 200, `p.evil-mesh.ru` → 200, `m.evil-mesh.ru` → 401.
- Браузерный прогон на изолированном экземпляре (PANEL_DATA_DIR=/tmp/sp-livetest,
  порт 3199, SSH-туннель на 3299, боевые данные не тронуты): редирект на форму,
  вход, дашборд, терминал (`whoami` → root, `PTY-OK` — подтверждён режим pty),
  выход → `/login` и 401 по погашенной сессии; ошибок консоли нет.
  Скриншоты: `.design-audit/beget-dash.png`, `beget-term.png`. Экземпляр,
  туннель и временные файлы удалены.
- Тесты на стенде: 204 теста — 198 pass, 1 fail, exit 1. Единственный fail —
  `shellSpec: fallback-цепочка соответствует окружению` (tests/terminal.test.js):
  тест не учитывал, что node-pty МОЖЕТ собраться; исправлен (при загруженном
  node-pty ожидается режим `pty`), файл передан на оба стенда, повторный прогон
  файла на beget — 4/4. Итог по набору: 199 pass / 0 fail.

**Осталось.** Оба стенда теперь на одном коде (1cc36ba + фикс теста). Из
несогласованного ранее: 7.1 (усиление panel_test), этап 5 (изоляция прав);
у пользователей с закэшированным Basic в браузере вход продолжит работать
по нему до смены пароля.

---

## 2026-10-14 — Страница авторизации: форма /login, сессии в HttpOnly-cookie, кнопка «Выйти»

**Запрос.** «Добавь нормальную страницу авторизации» — вместо родного браузерного
диалога HTTP Basic.

**Изменения — код панели.**

- `src/auth.js` — сессии формы входа: токен 24 байта в Map (лимит 512, вытеснение
  старейших), скользящий TTL `PANEL_SESSION_TTL_H` (по умолчанию 24 ч, продлевается
  каждым валидным запросом); `attemptLogin()` — общий с Basic антибрутфорс
  (счётчики/блокировка по IP, искусственная задержка при неудаче);
  `parseCookies()`/`sessionFromRequest()`; middleware сначала проверяет cookie
  `sp_session`, потом Basic; `changePassword()` гасит ВСЕ сессии; `deny()` для
  браузерных навигаций (Accept: text/html, не /api) отвечает `302 /login?next=...`
  вместо 401 — родной попап Basic больше не появляется; для API/curl контракт
  прежний: 401 JSON + WWW-Authenticate (проверено тестами auth.test.js).
- `src/admin/login.js` — новый модуль: `GET /login` (страница; уже вошедшему —
  редирект на next), `GET /login.js` (скрипт формы — единственный «публичный»
  ассет, без него форма мертва: остальная статика закрыта middleware), `POST
  /api/login` (свой CSRF-барьер: X-Requested-With + Origin/Referer + Sec-Fetch-Site
  — тот же набор, что в admin/routes.js; защита от login-CSRF), `POST /api/logout`.
  Cookie: HttpOnly, SameSite=Lax, Path=/, `Secure` при HTTPS (схема через
  `effectiveScheme`, экспортирован из httpserver.js). `safeNext()` не пускает
  `//`, `\` и внешние схемы в next (open-redirect).
- `src/index.js` — маршруты входа зарегистрированы ДО `auth.middleware` (форма
  сама является точкой получения доступа).
- `src/admin/public/login.html` — самодостаточная страница входа (инлайн-стили:
  CSP разрешает style-src 'unsafe-inline'; ссылки на style.css нет — она за
  авторизацией): карточка в стиле панели, логотип, обе темы, показ пароля «глазом».
- `src/admin/public/login.js` — тема из localStorage `sp-theme`, отправка формы
  fetch'ем с CSRF-заголовком, вывод ошибки сервера (в т.ч. текст блокировки),
  восстановление `next` (только пути внутри панели) с дописыванием утраченного
  серверным редиректом хеша.
- `src/admin/public/index.html` + `app.js` — кнопка «Выйти» в шапке (POST
  /api/logout → /login); при 401 фронт уводит на `/login?next=<текущий адрес>`
  вместо баннера «обновите страницу» (`redirectToLogin()`, `isAuthError()`);
  подсказка на странице «Пользователи» описывает новый вход.

**Найдено обкаткой.** Первый прогон формы был мёртв: `login.js` отдавался только
после авторизации (статика за middleware) — браузер получал 401 на скрипт; вылечено
явным маршрутом `GET /login.js` до middleware + тест «страница /login доступна без
пароля» проверяет и скрипт.

**Тесты.** `tests/login.test.js` — 8 тестов: страница без пароля + редиректы
браузерной навигации (и неизменный контракт 401+WWW-Authenticate для API), выдача
HttpOnly/SameSite-cookie и работа сессии, отклонение выдуманного токена, 401 при
неверном пароле (без выдачи cookie), login-CSRF без заголовка, выход гасит сессию,
смена пароля гасит сессии, общий антибрутфорс (форма 429, Basic 401+Retry-After),
safe-next без внешних адресов. Полный набор локально: 204 теста, 3 fail —
преморбидные T-32/T-43/T-44 (идентичны HEAD на Windows).

**Выкладка — panel_test.**

- Бэкап кода ДО: `/root/sitepanel-code-backup-20261013-212820.tar.gz` (62 файла).
- Заменены `src/` (26 .js, синтаксис проверен node --check) и `tests/`; новых
  зависимостей нет — npm не требовался; `systemctl restart sitepanel` → active.
- Проверки на стенде: `/healthz` ok; `GET /login` 200; `GET /login.js` 200;
  `GET /` с Accept: text/html → `302 /login?next=%2F`; `/api/system` без пароля →
  401. Внешне: `https://panel.evil-mesh.ru/login` → 200, `https://panel.evil-mesh.ru/`
  (html) → 302 на форму; `pqr` через прокси → 301 (штатный SSL-редирект).
- Браузерный прогон на стенде (изолированный экземпляр PANEL_DATA_DIR=/tmp/sp-livetest,
  порт 3199, SSH-туннель, боевые данные не тронуты): редирект на форму, ошибка при
  неверном пароле, вход по паролю первого запуска, `/api/system` по сессии 200,
  выход → `/login` и 401 по старой сессии; ошибок консоли нет. Скриншоты:
  `.design-audit/login-dark.png` (с ошибкой), `login-light.png`,
  `stand-login-dark.png`. Изолированный экземпляр и туннель удалены.
- Набор тестов на стенде: запущен фоном (`/tmp/stest-login.log`), результат
  сверяется по завершении — при выкладке локально 204/188 pass/3 fail (Windows).

**Осталось.** На panel_beget попадёт при следующей полной выкладке. Существующие
сессии Basic-браузеров (кэш учётных данных) продолжают работать — кому нужен
принудительный перелогин, ждёт истечения кэша браузера или смены пароля.

---

## 2026-10-14 — Современные контролы порогов диска/памяти в настройках оповещений

**Запрос.** «Сделай нормальные современные стили для изменения значений порогов
диска и памяти» (скриншот старых голых number-инпутов со штатными стрелками).

**Изменения.**

- `src/admin/public/app.js` — новые помощники `stepperHtml()` (разметка
  контрола) и `wireSteppers()` (связь ±-кнопок, ручного ввода и ползунка,
  клампинг 1..99, гашение ± на границах, обновление заливки `--fill`);
  блок «Оповещения Telegram» в `renderSettings` использует их вместо голых
  `<input type="number">`. Имена полей `disk`/`mem` сохранены — обработчик
  отправки формы не менялся.
- `src/admin/public/style.css` — секция «Степперы порогов»: карточка
  `.stepper-card`, степпер `.stepper` (− значение +, штатные стрелки
  number-инпута скрыты), слайдер `input.stepper-slider` с заполненной
  дорожкой (градиент по `--fill`) и круглым бегунком. Селектор именно
  `input.stepper-slider`: правило `[data-theme="light"] input { background:#fff }`
  при равной специфичности шло позже и гасило градиент дорожки (найдено
  обкаткой в браузере: дорожка не отрисовывалась в светлой теме).

**Проверка.**

- Локально (playwright chromium): кнопки +3/−1, синхронизация слайдера,
  клампинг (500→99, −5→1), `--fill` обновляется, границ 1/99 — ошибок
  консоли нет; скриншоты обеих тем: `.design-audit/stepper-dark.png`,
  `.design-audit/stepper-light.png`.
- `tests/ui.test.js` (10) и `tests/ui-browser.test.js` (2, включая e2e
  терминала) — зелёные; eslint чистый.
- **panel_test**: файлы `style.css`/`app.js` переданы по scp в
  `/opt/sitepanel/src/admin/public/` (размеры совпадают с локальными, 20
  вхождений `stepper` в CSS на стенде). Рестарт НЕ требовался — статика
  отдаётся с диска; `systemctl is-active` = active, `/healthz` = ok.
  Проверка по HTTP без пароля даёт 401 (Basic на месте), поэтому содержимое
  сверялось по файлам на диске.

**Осталось.** Ничего; на panel_beget попадёт при следующей полной выкладке.

---

## 2026-10-13 — Редизайн админки в стиле nginx-ui: боковое меню, темы, веб-терминал, страница «Пользователи»

**Запрос.** «Изучи demo.nginxui.com (admin/admin), сделай дизайн нашей панели в
похожем стиле: меню слева, дашборд, список сайтов, светлая и тёмная темы,
терминал, пользователи со сменой пароля. Тестируй и обкатывай на тестовой панели».

**Референс.** Демо nginx-ui изучено браузером (вход admin/admin): боковое меню
с активным пунктом-«пилюлей», шапка с хлебной крошкой и переключателем темы,
карточки-панели, тёмная тема по умолчанию, терминал (xterm), «User Profile» со
сменой пароля. Сняты скриншоты новых страниц нашей панели:
`.design-audit/new-*.png` (локальный прогон) и `.design-audit/stand-*.png`
(стенд).

**Изменения — код панели.**

- `src/admin/public/index.html` — новая оболочка: `aside.sidebar` (Дашборд,
  Сайты, Терминал, Пользователи, Настройки; сворачивание, мобильный ящик с
  backdrop), `header.topbar` (крошка, «Добавить сайт», переключатель темы),
  SVG-спрайт иконок. Все 4 модалки и aria-контракты (role="dialog",
  aria-modal, sr-only, aria-live) сохранены — тесты на них опираются.
- `src/admin/public/style.css` — переработан: палитры в `:root` (тёмная) и
  `[data-theme="light"]` (светлая), контраст обеих >= 4.5:1 (WCAG AA);
  боковое меню, таблица сайтов `.sites-table`, `.users-table`, `.term-*`,
  мобильный медиазапрос <= 900px (меню-ящик) и <= 760px (шапка).
- `src/admin/public/app.js` — hash-роутинг дополнен `#/terminal` и `#/users`;
  список сайтов переведён с карточек на таблицу с делегированием кликов и
  клиентским поиском (`#siteFilter`); дашборд/страница сайта/файлы/настройки
  сохранены (id-шники контрактов не менялись); форма смены логина/пароля
  переехала из «Настроек» на страницу «Пользователи»; тема —
  `data-theme` + localStorage `sp-theme` (по умолчанию системная);
  исправлена гонка: устаревший ответ опроса больше не перерисовывает
  ЧУЖУЮ страницу (захват `view` на момент запроса в `render()` и
  `refreshCurrentView()` — проявлялось как «список сайтов поверх терминала»).
- `src/admin/public/theme.js` — новый файл: применяет тему до первой отрисовки
  (inline-скрипты запрещены CSP).
- `src/admin/public/vendor/` — новый каталог: `xterm.js`, `xterm.css`,
  `addon-fit.js`, `xterm.LICENSE.txt` (vendored из @xterm/xterm,
  @xterm/addon-fit — MIT; пакеты в devDependencies, дистрибутив в репозитории,
  внешнего CDN нет).
- `src/admin/terminal.js` — новый модуль веб-терминала: WS-апгрейд на
  `/api/terminal/ws` порта админки; доступ по ОДНОРАЗОВЫМ токенам (48 hex,
  TTL 30 с, максимум 8 в полёте), выдаваемым только авторизованным запросом
  `POST /api/terminal/token` (Basic + CSRF-заголовок); same-origin проверка
  Origin на рукопожатии; максимум 3 сессии; ввод до 16 КБ/сообщение; PTY-цепочка
  `node-pty` (optionalDependencies; собирается там, где есть компилятор) →
  `script -qfc <shell> /dev/null` (util-linux; начальный размер через
  LINES/COLUMNS, ресайз — инъекцией `stty rows N cols M`, осознанная
  деградация) → сырой shell (Windows для разработки). Отправка — ТЕКСТОВЫМИ
  кадрами через StringDecoder: бинарные кадры не доставляются вебвью IAB
  (ввод доходил, вывод нет), а побайтовый toString рвал UTF-8 на границах
  чанков. На Windows в raw-режиме `\r` дополняется до `\r\n` (cmd.exe с пайпами
  не считает одиночный CR концом строки). `PANEL_TERMINAL=0` выключает
  функцию целиком.
- `src/admin/routes.js` — маршруты `POST /api/terminal/token`,
  `GET /api/terminal/status`, `GET /api/users` (список из одной учётки —
  панель администрируется одной записью auth.json).
- `src/index.js` — `terminal.attach(adminServer)` после поднятия админки,
  `terminal.shutdown()` в обработчике остановки (гасит shell-процессы).
- `package.json` — зависимости: `ws` ^8.22.0 (dependencies),
  `node-pty` ^1.0.0 (optionalDependencies), `@xterm/xterm` и
  `@xterm/addon-fit` (devDependencies).

**Изменения — тесты.**

- `tests/ui.test.js` — палитровый тест расширен на светлую тему
  (`cssVarLight`, блок `[data-theme="light"]`) + проверка `--accent` в обеих
  темах.
- `tests/terminal.test.js` — новый: одноразовость/TTL/переполнение токенов,
  same-origin апгрейда, выбор режима shell по платформе.
- `tests/ui-browser.test.js` — новый e2e-тест терминала (playwright):
  подключение, серверное приветствие, команда через `term.input` и её эхо.

**Диагностика (по ходу).** Три дефекта найдены обкаткой и исправлены:
гонка опроса (список поверх терминала), Blob-кадры WS (пустой вывод
терминала), `\r` без `\n` для cmd.exe. npm audit: 2 high — преморбидные
(node-forge через acme-client, не связаны с этой задачей).

**Выкладка — panel_test.**

- Бэкап кода ДО: `/root/sitepanel-code-backup-20261013-201709.tar.gz`
  (54 файла, без data/ и node_modules).
- Заменены `src/` (28 файлов), `tests/` (24), `package.json`,
  `package-lock.json`, `eslint.config.js` из `/tmp/redesign.tar` (удалён
  после выкладки). `npm install --omit=dev`: установлен `ws` 8.22.0;
  `node-pty` не собрался (нет g++) — панель работает в режиме `script`.
  Синтаксис 24 `.js` файлов проверен `node --check` до рестарта.
- nginx НЕ менялся: вхост `/etc/nginx/sites-available/sitepanel-admin` уже
  содержал `proxy_http_version 1.1` + `Upgrade`/`Connection "upgrade"`.
- `systemctl restart sitepanel` — active; слушатели 3100/8080/8443 на месте;
  `/healthz` → `{"ok":true}`; без пароля UI/API/token → 401 (авторизация
  цела); в журнале «Веб-терминал: ws-апгрейд на порту 3100».

**Проверка.**

- Локально (Windows, playwright chromium): 196 тестов — 180 pass, 3 fail
  (T-32/T-43/T-44 — те же 3 падают на чистом HEAD, проверено прогоном в
  отдельной worktree: Windows-особенности локальной машины, не регрессия).
- На panel_test: 196 тестов — 191 pass, 0 fail, 5 skip, exit 0.
- UI на стенде (изолированный экземпляр `PANEL_DATA_DIR=/tmp/sp-uitest`,
  порты 3199/3201/3202, PANEL_NO_AUTH=1, доступ через SSH-туннель; данные
  изолированы от боевого /opt/sitepanel/data): дашборд, список сайтов с
  реальным деплоем zip, страница сайта, терминал (`whoami && uname -a` —
  PTY через script, UTF-8 без искажений), «Пользователи» со сменой пароля,
  обе темы, мобильный вид (<= 420px, меню-ящик). Ошибок консоли браузера
  нет. Скриншоты: `.design-audit/stand-*.png`, `.design-audit/new-*.png`.
- Инфраструктура стенда после выкладки: `pqr` через прокси → 301 (SSL-редирект,
  штатно), `https://panel.evil-mesh.ru/` → 401 (Basic-приглашение, штатно).
  Изолированный экземпляр и временные файлы удалены, туннель закрыт.

**Осталось.**

- panel_beget выкладывается отдельно (по запросу; процедура идентична).
- Терминал: без `build-essential` на стенде ресайз работает через инъекцию
  `stty` (видно как команда в терминале). Для полного PTY-ресайза —
  `apt install build-essential g++` на стенд, затем `npm rebuild node-pty`.
- Пароль от базового UI `panel.evil-mesh.ru` не известен этой сессии —
  интерфейс боевого экземпляра стенда проверен через изолированный экземпляр
  на том же коде.
- `node-forge`/`acme-client` (npm audit high) — преморбидно, вне этой задачи.

---

## 2026-10-13 — panel_test: вычищен вхост rm; бэкапы вычищенного удалены

**Запрос.** «www.p.evil-mesh.ru можно игнорировать, бекапы того что вычищено из
тестовой панели не нужны. rm вычистить».

**Изменения — panel_test.**

- nginx: удалён вхост `rm` (`sites-available/rm` + симлинк; тело — заглушка
  из WORKLOG 2026-10-12: 80 → 404, 443 → `ssl_reject_handshake`). Провала в
  чужой сертификат нет: `000-ssl-reject` остаётся `443 default_server` с
  `ssl_reject_handshake`.
- Бэкапы вычищенного удалены из `/root` (решение пользователя):
  `cleanup-p-m-restored-20261013-1808{34,927}.tar.gz` (p и mesh-monitor),
  `rm-cleanup-full-20261012-072339.tar.gz`, `rm-cleanup-bak-20261012-072153.tar.gz`,
  `rm.nginx.bak.20261012-065609`, маркеры `.rm-cleanup-*last`.
  Оставлены не относящиеся к вычистке: `sitepanel-code-backup-*` (откаты кода),
  `sitepanel-backups/` (cron 7.3), `auth.json.bak`, `certs-default-old.bak`,
  `deploy/nginx-backup-*`, `pqr-panel-userdata-backup`, `stage2-deploy.tar.gz`.
- Итоговые вхосты panel_test: `000-ssl-reject`, `default`, `pqr-panel`,
  `sitepanel-acme`, `sitepanel-admin`.

**Проверка.**

- `nginx -t` успешен, reload применён.
- `rm.evil-mesh.ru` — **DNS-записи больше нет** (ENOTFOUND с рабочей машины);
  напрямую на `46.29.164.250:443` с SNI `rm.evil-mesh.ru` — TLS-отказ
  (`UNRECOGNIZED_NAME`).
- Не задеты: `pqr` → 200, `p` → 200, `pg` → 200, `m` → 401, админка теста → 401.

**Осталось.** — (чистка завершена; из несогласованного остаются только 7.1 и этап 5).

---

## 2026-10-13 — Домен p.evil-mesh.ru → сайт pg (panel_beget); вычистка panel_test

**Запрос.** «Перенеси домен p.evil-mesh.ru на сайт pg прод, удали сайт с тестового
стенда и вычисти все остатки, днс уже перенесен». DNS подтверждён через 1.1.1.1:
`p.evil-mesh.ru` и `www.p.evil-mesh.ru` → `141.133.197.43`.

**Диагностика.** На panel_test домен `p.evil-mesh.ru` обслуживался **вне панели**:
- nginx-вхост `pqr` (два server-блока: 443 → `localhost:3000` + ACME-прокси на
  9180; 80 → 301) — файл содержал только `p.evil-mesh.ru`, `pqr.evil-mesh.ru`
  обслуживал отдельный вхост `pqr-panel` (→ панель 8080);
- приложение — pm2-процесс `pqr` (pid 877, `/var/www/pqr`, порт 3000), юнит
  `pm2-root.service`;
- `www.p.evil-mesh.ru` — certbot-блоки в `default`-вхосте (контент — заглушка
  `/var/www/html`, 8 КБ), сертификат тот же `p.evil-mesh.ru`;
- `www.p.evil-mesh.ru` на прод НЕ переносился (пользователь просил только
  `p.evil-mesh.ru`); на проде для него вхоста нет → `ssl_reject_handshake`/
  444, как у прочих неизвестных имён.

**Изменения — panel_beget (продакт).**

- Реестр (панель остановлена на время правки): сайту `pg` (`88b1b76605e9`)
  добавлен домен `p.evil-mesh.ru` → domains: `["pg.evil-mesh.ru","p.evil-mesh.ru"]`.
- nginx `/etc/nginx/sites-available/p` (+ симлинк): 80 — ACME webroot + 301 на
  https; 443 — `p.evil-mesh.ru` → панель 8080 (шаблон pg, с WebSocket-заголовками).
- Сертификат: `certbot certonly --webroot -w /var/www/html -d p.evil-mesh.ru` —
  первая попытка упала (LE не смог скачать challenge — DNS для LE ещё не
  сошёлся), повторная через минуту — успешна (`live/p.evil-mesh.ru`).

**Изменения — panel_test (вычистка).**

- PM2: `pm2 delete pqr` (процесс pid 877 остановлен), `pm2 save` (список пуст),
  `pm2-root.service` stopped+disabled (других приложений в pm2 не было).
- nginx: удалены вхосты `pqr` (= p.evil-mesh.ru, файл целиком) и
  `mesh-monitor`; `default` переписан начисто (80 default_server, статика
  `/var/www/html`, без certbot-блоков www.p).
- Сертификаты: удалены `/etc/letsencrypt/{live,archive,renewal}` для
  `m.evil-mesh.ru` и `p.evil-mesh.ru`; остались `panel` и `pqr`.
- Панель: запись `3ebc4e88346e` (mesh-monitor) удалена из `db.json`
  (сайтов 2 → 1), каталоги `data/sites/3ebc4e88346e{,.backup}`, логи и
  pid-файл удалены.
- `/var/www/pqr` удалён (38 МБ).

**Бэкапы (в /root на panel_test).**

- `/root/cleanup-p-m-restored-20261013-180927.tar.gz` (7.4 МБ, 3475 файлов):
  `/var/www/pqr`, `/root/.pm2/dump.pm2.bak`, `db.json` до правки, лог монитора.
- **Инцидент бэкапа, честно:** первый архив `cleanup-p-m-20261013-180740.tar.gz`
  получился пустым (45 байт, 0 файлов) — tar запускался с относительными путями
  без `-C /`, ошибки были скрыты `2>/dev/null`. Ошибка замечена сразу после
  шага, но nginx-вхосты и сертификаты m/p к тому моменту уже были удалены.
  Восстановительный архив снят с `-C /` для оставшегося; тело удалённого
  вхоста `pqr` сохранено в тексте этой записи (см. выше в «Диагностике»);
  сертификат `m.evil-mesh.ru` — есть копия на panel_beget
  (`/etc/letsencrypt/live/m.evil-mesh.ru`); старый сертификат
  `p.evil-mesh.ru` тестового стенда не бэкапился — но домен уже обслуживается
  свежевыпущенным на проде, ключи отозваны де-факто удалением, при
  необходимости LE перевыпустит. Пустой архив удалён.

**Проверка.**

- panel_beget: `https://p.evil-mesh.ru` → **200** (приложение pg),
  `http://p.evil-mesh.ru` → **301** на https, `pg.evil-mesh.ru` → 200,
  `m.evil-mesh.ru` → 401 (MeshCentral Basic), админка `beget` → 401.
- panel_test: `pqr.evil-mesh.ru` → **200** (не затронут, панельный сайт на
  10001 жив), админка `panel` → 401; порты 3000/10000 свободны, pm2 пуст,
  `nginx -t` — успешен, служба панели active.
- Реестр panel_test: единственный сайт `pqr` (running).

**Осталось.**

- panel_test: вхост `rm.evil-mesh.ru` (заглушка 404/ssl_reject) и сайт
  `pqr` остаются по прежним решениям.
- `www.p.evil-mesh.ru` на проде не обслуживается (вхоста нет) — при
  необходимости добавить алиасом к `p`/`pg` по слову.

---

## 2026-10-13 — Именование стендов: panel_test / panel_beget

**Запрос.** «Для упрощения старый стенд будем называть panel_test (тестовый
стенд), новый panel_beget (продакт)».

**Изменения.**

- **panel_test** — `46.29.164.250` (хост `r1114848`): тестовый стенд (прежний
  «боевой»). Остался `pqr.evil-mesh.ru`, админка `panel.evil-mesh.ru`.
- **panel_beget** — `141.133.197.43` (хост `yblrhcoxcd`): продакт-стенд.
  На нём `pg.evil-mesh.ru` и перенесённый `m.evil-mesh.ru`, админка
  `beget.evil-mesh.ru`.
- `~/.ssh/config` рабочей машины: добавлены алиасы `panel_test` и
  `panel_beget` (тот же ключ `sitepanel_vps`); прежний алиас `sitepanel`
  оставлен — указывает на panel_test. Попутно исправлен ACL конфига
  (файл был доступен только на чтение: `icacls /grant EVIL-PC\pogpu:F`).
- `AGENTS.md` — раздел «Именование стендов» для будущих работ; правило
  соответствия со старыми названиями в журналах.

**Проверка.** `ssh panel_test hostname` → `r1114848`; `ssh panel_beget hostname`
→ `yblrhcoxcd`.

**Осталось.** — (изменение соглашения об именах; серверы не менялись).

---

## 2026-10-13 — Перенос mesh-monitor (`m.evil-mesh.ru`) со старого стенда на новый

**Запрос.** «Перенеси монитор на новый стенд». В ходе работ пользователь сообщил:
«Домен переключен на новую панель» — DNS-запись уже переведена.

**Диагностика.**

- Сайт на старом стенде: `3ebc4e88346e`, имя `mesh-monitor`, домен
  `m.evil-mesh.ru`, тип node (`npm start`), каталог 33 МБ
  (`/opt/sitepanel/data/sites/3ebc4e88346e`: `config.json`, `dist/`, `src/`,
  `public/`, `state.json` — данные монитора, `node_modules`), без отдельного
  `users/`. Второй сайт старого стенда `238b5bbfec01` = `pqr` — не трогался.
- Сертификат `m.evil-mesh.ru` на старом стенде (Let's Encrypt, действителен до
  2027-01-01), renewal — authenticator `nginx`.
- Порт приложения задаётся **не** переменной `PORT`, а `config.json`
  (`"port": 10000`) — на новом стенде 10000 занят `pg`, монитору назначен
  **10001**.

**Изменения.**

- Каталог сайта перенесён tar-потоком через рабочую машину (33 МБ, без
  изменений содержимого) в `/opt/sitepanel/data/sites/3ebc4e88346e` (каталог
  0700). Сертификат перенесён: `/etc/letsencrypt/{live,archive}/m.evil-mesh.ru`
  + `renewal/m.evil-mesh.ru.conf`.
- На новом стенде (панель остановлена на время правки): в `data/db.json`
  добавлена запись сайта `3ebc4e88346e` (`mesh-monitor`, домен
  `m.evil-mesh.ru`, порт **10001**, `npm start`, `autoStart: true`,
  `status: running`); `state.json` монитора (27 устройств) переехал с каталогом.
- **`config.json` монитора**: `"port": 10000` → `"port": 10001`. Бэкап:
  `/opt/sitepanel/data/sites/3ebc4e88346e/config.json.bak.20261013-*`.
  Прочие вхождения `10000` — таймаут `AbortSignal` в `dist/monitor/src/telegram.js`,
  не порт, не менялись.
- nginx-вхост `/etc/nginx/sites-available/m` (симлинк в `sites-enabled`) по
  шаблону pg: 80 → редирект на https + ACME webroot с fallback в панель,
  443 ssl (`/etc/letsencrypt/live/m.evil-mesh.ru/`) → прокси на `127.0.0.1:8080`
  с Upgrade/WebSocket-заголовками. `nginx -t` — успешен, reload применён.
- Продление переведено на webroot: `/etc/letsencrypt/renewal/m.evil-mesh.ru.conf`
  `authenticator = nginx` → `webroot`, `webroot_path = /var/www/html`,
  `installer = nginx` убран. Бэкап:
  `/etc/letsencrypt/renewal/m.evil-mesh.ru.conf.bak.20261013-*`.
  `certbot renew --cert-name m.evil-mesh.ru --dry-run` — **успешен**.
- Старый стенд: копия монитора остановлена (панель останавливалась, в
  `db.json` сайта `3ebc4e88346e` → `status: stopped`, `autoStart: false`),
  **каталог и сертификат на старом стенде сохранены** — откатив DNS, можно
  вернуть работу одной правкой записи. Причина остановки: два живых
  экземпляра монитора дублировали бы Telegram-алерты (`dist/monitor/src/telegram.js`).

**Проверка.**

- Новый стенд: приложение слушает `127.0.0.1:10001`, лог сайта
  `[monitor] загружено состояние (27 устр.) из state.json` и
  `[monitor] подключён к https://r.evil-mesh.ru`.
- Прокси панели (8080, Host: m.evil-mesh.ru) → `401` +
  `WWW-Authenticate: Basic realm="MeshCentral Monitor"` — штатная
  Basic-авторизация приложения.
- Извне (node fetch с рабочей машины): `https://m.evil-mesh.ru` → **401**
  с `Basic realm="MeshCentral Monitor"`; отдельно проверено принудительным
  `--resolve` на `141.133.197.43` — тоже 401.
- Транзиент 503 в процессе проверки объяснён: локальный DNS-кэш рабочей
  машины ещё держал старый IP, а старая копия уже была остановлена — 503
  «Сайт отключён» отдавала старая панель. После `ipconfig /flushdns` —
  устойчивый 401 с нового стенда.
- После рестарта панели старого стенда: `pqr.evil-mesh.ru` → 200 (не затронут),
  админки обоих стендов → 401, `pg.evil-mesh.ru` → 200.

**Осталось.**

- На старом стенде лежит остановленная копия сайта (`33 МБ` + `.backup`
  33 МБ) и вхост `/etc/nginx/sites-available/m` с сертификатом. По решению
  пользователя: удалить штатно через панель (после возврата DNS — недоступно,
  файлы можно снять руками) либо оставить как резерв. Продление на старом
  стенде теперь будет падать (DNS указывает на новый) — безвредно, но шумит
  в journald; можно убрать `m` из certbot timer старого стенда при декомиссии.
- У монитора БД — файл `state.json` в каталоге сайта: он переносится деплоем
  (PRESERVED_FILES), но при обновлении из git на новом стенде стоит помнить,
  что данные монитора живут в нём же.

---

## 2026-10-13 — Выкладка этапов 3–7 на оба стенда; I-05 снят (БД переехала)

**Запрос.** «7.2 … вычеркни, база на другом айпи… осознанно сделано не трогает,
выкладывай на стенды» — пункт I-05 (внешняя БД `92.101.71.244:5432`) снят
пользователем как неактуальный: база находится на другом IP. Задача 7.1 остаётся
несогласованной; осознанные упрощения не трогать. Выложить накопленный код
(этапы 3–7 + доработка домены/сертификаты) на оба стенда.

**Диагностика.** Перед выкладкой проверено:

- Коммит `9f29744` — рабочее дерево чистое, архив собран из HEAD
  (`git archive HEAD` → `.vps/stage3-7.tar`, 64 файла).
- `selfsigned` 5.5.0 требует Node ≥ 18 (`package.json.engines`) — Node боевого
  стенда v20.20.2 подходит.
- Боевой стенд: оба сайта (`238b5bbfec01`, `3ebc4e88346e`) живы, их процессы в
  **том же** cgroup `sitepanel.service`, `KillMode=control-group` — рестарт
  службы забирает сайты, сирот не останется (как в этапе 2).
- SSH-доступ: старый стенд — алиас `sitepanel` (`~/.ssh/config`, ключ
  `sitepanel_vps`), новый — `root@141.133.197.43` с тем же ключом.

**Изменения.** Скрипт выкладки `.vps/deploy-stage37.sh` (не в git: `.vps/`
в `.gitignore`) — бэкап кода → замена `src`/`tests`/`package.json`/
`package-lock.json`/`eslint.config.js`/доков из архива → `npm install --omit=dev`
при расхождении → `node --check` всех `src/**` → `systemctl restart` → проверки.
Каталог `data/` не трогался. Дополнительно: правка `tests/stage6-quality.test.js`
(см. «Диагностика тестов» ниже) перезалита на оба стенда поверх архива.

**Тесты на стендах** (полный набор `node tests/run.js`):

- Новый стенд (Node v22.22.1, `yblrhcoxcd`): **189 тестов, pass 185, fail 1,
  skipped 3**. Единственный fail — **T-02** (`stage6-quality.test.js`): тест
  делает `chmod 0500` на каталог данных, но панель на стенде работает от root,
  а root пишет в 0500-каталог без вопросов (CAP_DAC_OVERRIDE) — симуляция сбоя
  записи правами под root невозможна. Добавлен skip при `process.getuid() === 0`
  (тест остаётся рабочим в CI от непривилегированного пользователя); после
  правки файл прогнан на стенде: 3 pass / 0 fail / 1 skip.
- Боевой стенд (Node v20.20.2, `r1114848`): **189 тестов, pass 185, fail 0,
  skipped 4** (T-02 под root, T-12/T-33 — известные заглушки этапа 2,
  `ui-browser` — Playwright не установлен на стенде).

**Проверка выкладки** (оба стенда):

- Служба `active`; слушатели `127.0.0.1:3100`, `*:8080`, `*:8443`.
- `/healthz` без авторизации → `200 {"ok":true,...}` (7.4 работает).
- `/api/system` и `/` без пароля → `401`.
- `selfsigned` 2.4.1 → **5.5.0** на обоих стендах (`npm install --omit=dev`).
- Заголовки на трафике сайтов: `X-Frame-Options: SAMEORIGIN`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` — проверены
  curl'ом на стенде и node-fetch'ом с рабочей машины; у сайтов появился
  диагностический `X-Sitepanel-Site`.
- Маркер миграции прав (M-04, `HARDEN_VERSION=2`): на боевом стенде при старте
  «Права на секреты обновлены: 2 файл(ов)» (разово, ужаты 2 файла); на новом —
  0 (права уже актуальны).
- Сайты с рабочей машины (node fetch): `https://pg.evil-mesh.ru` → **200**
  (заголовки SAMEORIGIN/nosniff/`X-Sitepanel-Site: 88b1b76605e9`),
  `https://pqr.evil-mesh.ru` → **200**, `https://m.evil-mesh.ru` → **401 с
  `WWW-Authenticate` от самого приложения** — собственная Basic-авторизация
  MeshCentral работает при новой зачистке `Authorization` (H-14 не мешает),
  админки `beget`/`panel` → `401`, `healthz` обеих админок → `200`.
- `db.json` изменился на обоих стендах при остановке службы — **ожидаемо**:
  новый код выбрасывает телеметрию (`health`/`fails`) из записи при
  `flush()` в shutdown (M-02). `auth.json` не изменился
  (новый стенд: `7007d9587a6b3c2e47470da4b7438922`, боевой:
  `41dd9910c2a07af32b005bc687ed3e19` — до и после совпадают).
- md5-сверка трёх сторон (локальная копия, новый стенд, боевой) — 8 ключевых
  файлов (`src/sites/manager.js`, `src/index.js`, `src/httpserver.js`,
  `src/ssl/acme.js`, `src/ssl/certs.js`, `src/store.js`,
  `tests/stage6-quality.test.js`, `package.json`) — **все совпадают**.
- 7.3 автоматизирован: `/usr/local/sbin/backup-sitepanel.sh` установлен
  (права 0700), cron `30 4 * * *` добавлен в root crontab обоих стендов;
  пробные прогоны создали `/root/sitepanel-backups/20261013-155544` (новый,
  certs 4 файла) и `/root/sitepanel-backups/20261013-125855` (боевой, certs
  6 файлов); `state.json` ещё не создаётся — защёлки алертов не срабатывали.
- Бэкапы кода перед заменой: `/root/sitepanel-code-backup-20261013-153632.tar.gz`
  (новый стенд, 55 файлов), `/root/sitepanel-code-backup-20261013-125738.tar.gz`
  (боевой, 55 файлов). Откат: `systemctl stop sitepanel && tar xzf <архив> -C
  /opt/sitepanel && systemctl start sitepanel`.
- I-05 (внешняя БД) — **снят пользователем**: база находится на другом IP,
  аудит-адрес больше не актуален. `scripts/probe-external-db.sh` оставлен как
  универсальный инструмент (принимает host/port аргументами).

**Осталось.**

- 7.1 (усиление старого стенда) — ранбук готов, НЕ применён, ждёт согласия.
- Blue/green в полном смысле (переключение портов) — сознательное упрощение.
- Этап 5 (изоляция прав) — по плану требует согласия и окна обслуживания.
- При первом включённом алерте появится `data/state.json` (SP-22) — он
  подхватывается бэкап-скриптом автоматически.

---

## 2026-10-13 — UI: привязанные домены и покрытие их сертификатом

**Запрос.** «В панели сайта в панели домены необходимо показывать уже привязанные
домены, а в графе сертификатов показывать сертификаты по всем привязанным доменам».

**Диагностика.** Показ привязанных доменов с кнопкой отвязки в панели «Домены»
(#domainList, U-08) уже реализован в этапе 6 (см. запись ниже) — но ещё не выложен
на стенды. Чего не хватало: блок «SSL-сертификат» показывал только провайдера и
даты; домены попадают в сертификат лишь в момент выпуска, и привязка нового
домена после выпуска оставалась невидимым расхождением — домен маршрутизируется
панелью, но на HTTPS не отвечает (SNI отдаёт сертификат по умолчанию).

**Изменения.** `src/admin/public/app.js` — `sslInfoHtml(site)` при активном
сертификате выводит таблицу «Покрытие привязанных доменов»: для каждого домена
из `site.domains` бейдж «покрыт» (в `site.ssl.domains`), «не покрыт» (нет в
сертификате) или «без сертификата» (wildcard — LE по HTTP-01 невозможен, нужен
DNS-01, подсказка о перевыпуске для него не показывается); при непокрытых
не-wildcard доменах — предупреждение о перевыпуске («Выпустить Let's Encrypt»);
при доменах в сертификате, отвязанных от сайта, — пометка со списком.
Тесты: `tests/ui-badge.test.js` — 4 регрессии на `sslInfoHtml` через VM-песочницу
(покрытие/непокрытый домен + подсказка, лишний домен сертификата, wildcard,
неактивный SSL). `CHANGELOG.md` — пункт в «Добавлено».

**Проверка.**

- `node --check src/admin/public/app.js`; `npx eslint src tests` — 0 проблем.
- `tests/ui-badge.test.js` — **9/9 pass**; `tests/ui-browser.test.js`
  (Playwright, реальный Chromium) — pass.
- Полный набор `node tests/run.js` (Windows): **189 тестов, pass 173, fail 3,
  skipped 13** — только платформозависимые T-32/T-43/T-44 (идентичны `v1.0.2`).

**Осталось.** Выкладка на стенды (вместе с этапами 3–7); поведение live-проверить
на `pg.evil-mesh.ru` после выкладки.

---

## 2026-10-13 — Этапы 6–7 плана: качество кода и процессы; обслуживание стендов

**Запрос.** «Давай дальше 6–7» — выполнить этап 6 ([PLAN.md](PLAN.md):1897-1914)
и этап 7 ([PLAN.md](PLAN.md):1916-1924). Этап 5 (изоляция прав) пропущен по
плану: требует согласия и окна обслуживания.

**Диагностика.** Решения по ходу:

- *P-04.* Полное blue/green (переключение портов) не делалось — реализована
  посильная половина с большей частью пользы: клонирование/распаковка/сборка
  переехали ДО `deployBegin` и `_stop`. Сценарии найдены тестом: (а) первая
  редакция доверяла только `PANEL_TRUST_PROXY`-списку, но оставляла loopback —
  исправлено на «список заменяет умолчание»; (б) тест P-04 собирал сайт с
  `package.json` на несуществующий `x.js` — сайт был `crashed` ещё до деплоя,
  тест проверял не то. Битый zip проверен отдельной пробой: 500, сайт `running`,
  старая версия отвечает — ожидаемое поведение нового потока.
- *P-09* — уже был реализован в `detectType` (прямой `node <путь>` при простом
  скрипте `start`); подтверждено чтением, в CHANGELOG отмечено как проверенное.
- *selfsigned 5.x* — `generate()` асинхронный; `ensureDefaultCert`/`issueSelfSigned`
  стали async, оба вызывающих (index.js, маршрут selfsigned) ждут. API 5.5.0
  проверен пробой (`pems.private/cert`).
- *UI-тесты в песочнице* — `tests/ui-badge.test.js` эвалирует `app.js` в
  `vm`-песочнице; новые top-level `window.addEventListener('hashchange')` и
  чтение `location.hash` на старте требовали дополнить песочницу (`window`,
  `location.hash`).
- *Playwright* — установлен локально (chromium), браузерный тест прогнан
  реально; файл скипается без библиотеки, чтобы набор оставался зелёным.
- *CHANGELOG* — при склейке секций `[Unreleased]` (этапы 3–4 + 6–7) первая
  редакция правок потеряла заголовки релизов; файл восстановлен из git
  (`git show HEAD:CHANGELOG.md`) и блок пересобран заново. Итог проверен:
  один набор секций, все три релиза на месте.

**Изменения.** Рабочая копия `D:\Projects\SitePanel`; на стенды не выкладывалось.

- *6.3 UI* — `src/admin/public/app.js` (таймаут `api()` 5 мин, баннер связи и
  бэкофф вместо `location.reload()`, hash-роутинг с `navigate()`, пауза опроса
  в скрытой вкладке, домены с отвязкой, переименование/автозапуск, auto-disable
  кнопок, `inert`+busy на модалках, удалён `isTextFile`); `style.css`
  (`.panel.span2`, `display:inline-block` у `.health-cell`, цели ≥24px,
  `::placeholder #94a3b8`, `.conn-banner`, `.global-progress`, удалён
  `.btn-icon`); `index.html` (баннер, глобальный прогресс).
- *6.4* — `src/store.js`: `STATE_VERSION=1`, `migrate()`, нормализация порогов
  алертов.
- *6.5* — `src/alerts.js` (один snapshot на проверку); `src/index.js` (почасовой
  `cleanTemp` с `unref`). SP-10/SP-25 проверены по коду — закрыты ранее.
- *6.6* — `src/sites/manager.js`: `_deploy` и `_deployFromGit` собирают staging
  до `deployBegin`/`_stop`; `finalizeDeploy` принял `installWarning`.
- *6.7* — проверен существующий `detectType` (без изменений кода).
- *6.9* — `package.json`/`package-lock.json` (`selfsigned ^5.5.0`), `src/ssl/certs.js`
  (async), `src/index.js:49` (`await`), `src/admin/routes.js` (`await`).
- *6.1/6.8* — `.github/workflows/ci.yml` (Node 20/22/24: `node --check`, eslint,
  `node tests/run.js`), `eslint.config.js`, devDeps `eslint/@eslint/js/globals`,
  `npm run lint`; правки по линтеру в 12 файлах (неиспользуемые переменные,
  устаревшие eslint-disable, песочница ui-badge).
- *6.2* — `tests/ui-browser.test.js` (Playwright: дашборд, hash-роутинг U-12,
  домены U-08, health-полоска U-02, модалка U-04, парольное поле токена A-02,
  таймер логов U-09/T-39, чистая консоль).
- *6.10* — `tests/stage6-quality.test.js`: T-02 (chmod 0500 на data/ → 5xx →
  восстановление), SP-15, P-04, 7.4.
- *7.3/7.1/7.2* — `scripts/backup-sitepanel.sh` (cron-бэкапы с ротацией),
  `scripts/harden-old-stand.sh` (НЕ применялся), `scripts/probe-external-db.sh`.
- *7.4* — `src/index.js`: `GET /healthz` до auth-мидлвари.
- `README.md` — тесты/lint/Playwright/CI, раздел «Обслуживание стенда».

**Проверка.**

- `node --check` всех `src/**/*.js`, `tests/**/*.js`; `npx eslint src tests` —
  0 проблем.
- `tests/stage6-quality.test.js`: pass 3 + skip 1 (POSIX). `tests/ui-browser.test.js`:
  pass 1 (реальный Chromium). `tests/ui-badge.test.js`: 5/5 после дополнения
  песочницы.
- Полный набор `node tests/run.js` (Windows): **185 тестов, pass 169, fail 3,
  skipped 13** — падают только платформозависимые T-32/T-43/T-44 (идентично
  чистому `v1.0.2`).
- CI прогнать негде (нет push из сессии) — workflow сработает при следующем
  `git push`; шаги те же, что выполнены локально.

**Осталось.**

- **7.1 НЕ применён** (требует явного согласия по AGENTS.md): ранбук
  `scripts/harden-old-stand.sh` готов; применять только с открытой второй
  ssh-сессией и консолью провайдера под рукой.
- **7.2** — внешняя зависимость: прогнать `scripts/probe-external-db.sh` на обоих
  стендах и передать вывод владельцу БД (белый список/файрвол).
- Автоматизация бэкапов (7.3) требует установки скрипта в cron на стендах —
  при следующей выкладке.
- Blue/green в полном смысле (переключение порта без остановки) не сделано —
  см. P-04 в CHANGELOG.
- Выкладка этапов 3–7 на стенды — одной порцией, после прогона на Linux.

---

## 2026-10-13 — Этап 4 плана: наблюдаемость и эксплуатация

**Запрос.** «Приступай к следующему» — выполнить этап 4 [PLAN.md](PLAN.md):1874-1888
(P2), задачи 4.1…4.9, вслед за этапом 3 (см. запись выше). Выполняется в той же
сессии поверх коммита этапа 3 (`a0b7af2`).

**Диагностика.** Решения по ходу:

- *M-02, телеметрия.* `health`/`fails` перенесены из записей сайта в память
  монитора (`telemetry` Map); API (`/api/sites`, `/api/sites/:id`,
  `/api/sites/:id/health`) читает их через `monitor.healthFor` — контракт ответов
  не изменился. Прямой `store.save()` из `checkSite` убран: изменения статуса
  идут через `setStatusIf`, который сохраняет сам. В `store.validateSite`
  ключи `health`/`fails` выбрасываются — старые db.json перестанут таскать
  телеметрию после первой перезаписи. Интервал тика — `PANEL_MONITOR_TICK_MS`
  (умолчание 30 с, минимум 250 мс): переменная нужна тестам, нижняя граница
  защищает от самосDDoS.
- *M-07, кэш статистики.* Ключ кэша — siteId + **pid**: найдено тестом
  `deploy.test.js:174` (проверяет свежий pid после рестарта) — кэш только по
  siteId возвращал бы устаревший pid в 5-секундном окне.
- *M-04, миграция прав.* Старые тесты `permissions.test.js` вызывают
  `hardenDataDir({dataDir})` напрямую на свежем каталоге — маркер не мешает
  (его нет → миграция выполняется). Для несуществующего каталога добавлен
  ранний `return 0` БЕЗ создания каталога: раньше его создавал бы маркер через
  `writePrivateAtomic` (mkdirPrivate на ENOENT). `fullchain.pem` остаётся 0644,
  `sites/<id>` ужимается целиком (0700), но внутрь (node_modules) обход не ходит.
- *SP-22.* Состояние пишется в `data/state.json` с версией формата; чужая или
  битая версия = чистое состояние, не авария. Запись отложенная (1 с), атомарная
  (`writePrivateAtomic`, 0600).
- *M-05.* Ломать `statfs` патчем в тесте нельзя — на машине с Git Bash
  `df` из PATH существует, и фолбэк давал данные (найдено прогоном). Тест
  указывает `config.dataDir` на несуществующий каталог (ломаются оба пути),
  затем «чинит» созданием каталога.

**Изменения.** Правки в рабочей копии `D:\Projects\SitePanel`; на стенды не
выкладывались.

- `src/monitor.js` — телеметрия в памяти (`telemetry`, `healthFor`), guard тика
  (`tickRunning`), `forgetSite` (история + телеметрия + кэш статистики), кэш
  `statsFor` 5 с по pid (M-02/M-03/M-07), интервал из `config.monitorTickMs`.
- `src/alerts.js` — `persistState`/`restoreState`/`getStateSnapshot`, состояние
  в `data/state.json` (version 1), вызовы `persistState()` во всех переходах
  защёлок, `restoreState()` до первого тика в `start()` (SP-22).
- `src/securefile.js` — `hardenDataDir`: точечный список путей + маркер
  `.permissions-hardened` с `HARDEN_VERSION=2` (M-04).
- `src/dashboard.js` — `readDisk` возвращает значение (не мутирует состояние),
  `refreshDisk` с try/catch: `diskCheckedAt` только при успехе, `diskError` в
  snapshot (M-05).
- `src/store.js` — `validateSite` выбрасывает `health`/`fails` (M-02).
- `src/admin/routes.js` — `health` из `monitor.healthFor`; `DELETE /sites/:id`
  вызывает `monitor.forgetSite` (M-03).
- `src/config.js` — `stateFile`, `monitorTickMs`.
- `src/httpserver.js` — `TRACE` → 405 с `Allow`; `X-Sitepanel-Site` на статике (H-10).
- `package.json` — `engines.node` `>=20` (M-06).
- `README.md` — systemd-юнит `Restart=on-failure` + `StartLimit*` (I-02),
  Node ≥ 20, таблица `data/` дополнена (`db.json.bak`, `state.json`,
  `sitepanel.lock`).
- `tests/stage4-observability.test.js` — новый, 7 тестов
  (M-02, M-03, M-04 ×2, M-05, SP-22, H-10).

**Проверка.**

- `node --check` всех изменённых `.js` — без ошибок.
- `tests/stage4-observability.test.js` локально (Windows, Node v24.21.0):
  **pass 5 / fail 0 / skip 2** (M-04×2 — POSIX).
- Полный набор `node tests/run.js` локально: **180 тестов, pass 165, fail 3,
  skipped 12**. Падают те же T-32/T-43/T-44, что и на чистом `v1.0.2`
  (платформозависимые, см. запись об этапе 3) — регрессий нет.
- На Linux-стендах набор не прогонялся — выкладка не выполнялась (см. «Осталось»).

**Осталось.**

- Выкладка этапов 3 и 4 на оба стенда (одной порцией): прогон полного набора на
  Linux, бэкап кода по разделу 4 плана, `systemctl restart sitepanel`, проверка
  сайтов и заголовков. При выкладке учесть: маркер `HARDEN_VERSION=2` — первый
  старт после обновления один раз ужмёт права (в логе «Права на секреты
  обновлены»); телеметрия исчезнет из db.json после первой записи.
- Этапы 5–7 плана не начаты (изоляция прав — требует согласия и окна
  обслуживания; стенды — по согласованию).

---

## 2026-10-13 — Этап 3 плана: HTTP, TLS, ACME и секреты

**Запрос.** «Реализуй дальше по этапам начиная с 3» — выполнить этап 3
[PLAN.md](PLAN.md):1848-1868 (P2), задачи 3.1…3.18. Задачи 3.3 (H-05),
3.6 (H-09) и 3.12 (H-15) были закрыты попутно при этапах 1–2 и вошли в
релиз `v1.0.2` (см. предыдущую запись).

**Диагностика.** Решения, принятые по ходу (каждое проверено кодом или пробой):

- *H-14, stripping `Authorization`.* План требовал «не передавать `Authorization`
  в upstream», но безусловная зачистка сломала бы сайты со СВОЕЙ Basic-авторизацией —
  прежде всего `m.evil-mesh.ru` (MeshCentral Monitor, штатный 401 от самого
  приложения). Решение: заголовок удаляется только если учётные данные в нём
  совпадают с учёткой панели (проверка через `auth.checkCredentials`, кэшируется
  — по тем же причинам, что A-01); чужие заголовки проходят. `Cookie` не трогается
  вовсе: панель cookies не выставляет, все cookies принадлежат приложениям сайтов.
  Поведение http-proxy проверено чтением
  `node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:75-87`: `xfwd`
  ДОПИСЫВАЕТ `x-forwarded-for/port/proto` к существующим значениям и ставит
  `x-forwarded-host` только при отсутствии — поэтому входящие `X-Forwarded-*`
  удаляются до проксирования, после чего библиотека собирает их из реального
  сокета.
- *H-13, заголовки на трафике сайтов.* `setHeader` до `proxy.web` переживает
  проксирование (Node объединяет `setHeader` с заголовками из `writeHead`) —
  проверено тестом на живом node-сайте. Для сайтов выбран `X-Frame-Options:
  SAMEORIGIN` (а не `DENY`, как у админки), чтобы не ломать валидный фрейминг
  сайта на его же домене. CSP добавлен только заглушкам (`default-src 'none'`):
  CSP на произвольных сайтах ломал бы чужую разметку. Опциональный отказ для
  конкретного сайта (по плану «не по умолчанию») НЕ делался — см. «Осталось».
- *H-07, доверие `X-Forwarded-Proto`.* `PANEL_TRUST_PROXY` со списком адресов
  ЗАМЕНЯЕТ умолчание «доверять loopback» (иначе отрицательный сценарий
  «nginx переехал на другой хост» был бы невыполним). Найдено тестом: первая
  редакция доверяла loopback всегда, и тест с `PANEL_TRUST_PROXY=192.0.2.7`
  ловил, что подделка с 127.0.0.1 по-прежнему работает.
- *H-18, лок выпуска.* `issueCertificate` целиком обёрнут в `withSiteLock`:
  вызывающие (маршрут `/ssl/issue` и цикл продления) наружного лока не держат,
  повторный вход в лок исключён. Повторный выпуск раньше чем через 60 с
  отклоняется (лимит дубликатов LE 5/нед).
- *H-04, карта challenge.* Ключ `домен|токен`; выпуск трекает свои токены в
  локальном `Set` и в `finally` удаляет только их. Реальный ACME-цикл в тестах
  не гоняется (нужна сеть и аккаунт LE) — поведение карты и раздачи по Host
  покрыто юнит-тестом и интеграцией через публичный прокси без ACME.

**Изменения.** Все правки — в рабочей копии `D:\Projects\SitePanel`, коммит
поверх тега `v1.0.2`. На стенды НЕ выкладывалось (см. «Осталось»).

- `src/httpserver.js` — `applySiteSecurityHeaders` для всех ответов публичного
  прокси (`nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, HSTS по
  HTTPS); `STUB_CSP` в `sendPlaceholder`; `trustedForwarder`/`effectiveScheme`
  (H-07); `sanitizeForwardHeaders` + `stripPanelAuthorization` в `proxyToNode`
  и `routeUpgrade` (H-14); `originAllowed` на WS-апгрейде (H-21); ETag/
  Last-Modified/304 и gzip в `serveStatic` (H-08); `acme.getChallenge(host, token)`;
  экспорт `realInside` (для файлового менеджера).
- `src/config.js` — `PANEL_TRUST_PROXY` и `parseTrustProxy` (`[]` → только
  loopback; `*`/`all` → всем; иначе список адресов).
- `src/admin/routes.js` — `csrfGuard`: проверка `Origin`/`Referer`/`Sec-Fetch-Site`
  (A-03); `GET /settings` отдаёт `telegramTokenSet`+`telegramTokenHint` вместо
  токена, `PUT` принимает новый токен/маску/`telegramTokenReset` (A-02);
  валидация `domains` в `/ssl/issue` через `normalizeDomain` (H-19); лог
  `[auth] пароль изменён` без пароля (A-05); `safePath` с realpath-контейнментом
  через `realInside` (H-03).
- `src/ssl/acme.js` — карта challenge `домен|токен`, `setChallenge`/`removeChallenge`,
  очистка только своих токенов (H-04); `issueCertificate` под `withSiteLock`,
  staging из записи сайта для повторных выпусков, интервал 60 с (H-18); цикл
  продления — по одному сайту за тик, джиттер ±30 мин (H-04).
- `src/ssl/certs.js` — `ensureDefaultCert` требует оба файла (H-17).
- `src/sites/manager.js` — маска прав из архива `mode & 0o755` (H-20).
- `src/alerts.js` — `redactToken` в журналах ошибок Telegram (A-02).
- `src/admin/public/app.js` — поле токена парольное, пустое, с подсказкой
  «сохранён (***XXXX)», чекбокс «Удалить сохранённый токен»; форма шлёт токен
  только если введён (A-02).
- `README.md` — раздел «Ротация ключей и секретов», обновлены заметки по
  безопасности (A-05, H-13/H-14/H-07).
- `tests/stage3-security.test.js` — новый, 15 тестов (H-03/H-04/H-07/H-08/
  H-13/H-14/H-17/H-19/H-20/H-21/A-02/A-03/A-05).
- `package-lock.json` — синхронизация внутренних полей версии с `1.0.2`
  (в релизном коммите не обновлялись).

**Проверка.**

- `node --check` всех изменённых `.js` — без ошибок.
- Локальный полный прогон `node tests/run.js` (Windows, Node v24.21.0):
  **173 теста, pass 160, fail 3, skipped 10**. Падают T-32, T-43, T-44 —
  платформозависимые (чёрная дыра git, группы процессов POSIX). **Проверено на
  чистом `v1.0.2`** (git-worktree в `/tmp/sp-v102`, прогон того же файла):
  идентичные 3 падения — регрессий этап 3 не даёт; на Linux-стендах эти тесты
  проходили при выкладке этапа 2 (см. запись ниже).
- `tests/stage3-security.test.js` локально: **pass 13 / fail 0 / skip 2**
  (симлинки и права — POSIX, на Windows скипаются).
- Бэкапов конфигов не требуется: правки серверов и стендов не было.

**Осталось.**

- **Выкладка на оба стенда не выполнялась** (запрос был про реализацию): перед
  выкладкой — прогон полного набора на Linux (`node tests/run.js`, ожидается
  0 fail), бэкап кода по регламенту раздела 4 плана, затем `systemctl restart
  sitepanel` и проверка сайтов. Особое внимание: `m.evil-mesh.ru` (Basic сайта
  должен продолжить работать — покрыто тестом H-14), заголовки `X-Frame-Options:
  SAMEORIGIN` на сайтах (если какой-то сайт встраивается с чужого домена —
  понадобится per-site opt-out, его нет).
- H-04/H-18 проверены юнит-тестами и чтением кода; живой ACME-цикл не гонялся —
  при выкладке стоит выпустить тестовый сертификат в staging-режиме LE.
- Per-site opt-out для `X-Frame-Options`/`Referrer-Policy` не реализован
  (по плану «с возможностью осознанного отказа» — отложено до потребности).
- Этап 4 плана (наблюдаемость и эксплуатация) не начат.

---

## 2026-10-13 — Релиз 1.0.2: закрытие этапов 1–2 плана

**Запрос.** «Реализуй дальше по этапам начиная с 3, закрой по 2 с тегом 1.0.2» —
зафиксировать выполненные этапы 1–2 [PLAN.md](PLAN.md) релизным тегом `v1.0.2`
и продолжить этапом 3.

**Диагностика.** Оба этапа уже выполнены, прогнаны тестами (156/158, 0 fail,
2 skipped) и выложены на оба стенда (см. записи ниже); но в git изменения не
были закоммичены — рабочее дерево `main` содержало 19 изменённых и 13 новых
файлов. Версия в `package.json` оставалась `1.0.1`, все записи — в
`[Unreleased]` `CHANGELOG.md`.

**Изменения.** Только документы и метаданные; код панели не менялся.

- `CHANGELOG.md` — секция `[Unreleased]` переименована в
  `[1.0.2] — 2026-10-13` с преамбулой об этапах 1–2; добавлена пустая
  `[Unreleased]`; обновлены ссылки сравнения внизу файла
  (`v1.0.1...v1.0.2`, `v1.0.2...HEAD`).
- `package.json` — `"version"` `1.0.1` → `1.0.2`.
- Настоящая запись в `WORKLOG.md`.
- Коммит всех накопленных изменений этапов 1–2 (код, тесты, `PLAN.md`,
  `WORKLOG.md`, `AGENTS.md`) и аннотированный тег `v1.0.2`.

**Проверка.** `node -e "require('./package.json').version"` → `1.0.2`;
`git tag -l` → `v1.0.0`, `v1.0.1`, `v1.0.2`. Код под тегом совпадает с уже
выложенным на стенды (сверка md5 выполнена при выкладке этапа 2 — см. запись
ниже), отдельная выкладка не требуется.

**Осталось.** Этап 3 ([PLAN.md](PLAN.md):1848-1868) — выполняется следующим
коммитом поверх тега.

---

## 2026-10-13 — Этап 2 плана: устойчивость процессов и деплоя; выкладка на оба стенда

**Запрос.** (m03532) «начинай 2 этап» — выполнить этап 2 [PLAN.md](PLAN.md):1804-1846
(«Устойчивость процессов и деплоя», P1), задачи 2.1…2.36, с критерием готовности
из того же раздела: серия из 20 деплоев с `SIGKILL` посреди каждого не оставляет
сайт без каталога; перезапуск панели при живом сироте не создаёт второй процесс;
отклик на запрос во время деплоя — `503` с `Retry-After`.

**Диагностика.** Ключевые находки, добытые в ходе этапа (ниже — только то, что
меняло решение; дефекты, найденные **тестами**, перечислены в «Изменениях»).

*Про `git clone` (P-13).* Таймаут был реализован, но не работал: `spawn('git', …)`
не имел `detached`, поэтому `killTree` на POSIX делал `process.kill(-child.pid)`
по группе **панели** (не git'а), получал `ESRCH` и падал в `child.kill()` —
убивался только сам `git`, а его потомок `git-remote-https` наследовал pipe'ы и
переживал сигнал. Node ждёт закрытия `stdio`, поэтому событие `close` не
наступало **никогда**: промис `gitClone` не завершался, а вместе с ним вечно
держалась блокировка сайта (`withSiteLock`). Доказано пробой
`D:\Projects\SitePanel\.vps\probe-gitclone.cjs` (через публичный путь
`manager.deployFromGit`, потому что `gitClone` наружу не экспортируется) и
отдельно наблюдалось как «повисший» тест T-32.

*Про zip-бомбу (P-15).* Счётчик `writtenBytes` в `extractZip` **не защищает
память**: `adm-zip` разжимает запись целиком внутри `entry.getData()` раньше, чем
счётчик увидит байты. Хуже того, в `node_modules/adm-zip/methods/inflater.js:5`
при заявленном размере `0` ограничение снимается полностью
(`expectedLength > 0 ? {maxOutputLength: …} : {}`). Замер проб
`D:\Projects\SitePanel\.vps\prob-bomb2.cjs` / `prob-bomb4.cjs`: подделка
`uncompressed size = 0` при реальных 200 МБ нулей давала **рост RSS +368 МБ**
(в исходном коде) и лишь потом ошибку CRC.

*Про `proxyTimeout` (H-06).* Опция `timeout` у `http-proxy` **ломает ответ
клиенту**: она делает `req.socket.setTimeout()` на сокете КЛИЕНТА
(`node_modules/http-proxy/lib/http-proxy/passes/web-incoming.js:52-56`), поэтому
при срабатывании клиент получает `ECONNRESET` вместо страницы `502`. Проверено
пробой `D:\Projects\SitePanel\.vps\probe-proxy2.cjs` (4 варианта): только
`proxyTimeout: 3000` → `502` за 3030 мс; только `timeout: 3000` → `ECONNRESET`;
оба (как было) → `ECONNRESET`. `proxyTimeout` вешает таймаут на запрос К
АПСТРИМУ и абортит его (`:139-143`), поэтому ошибка доходит до
`proxy.on('error')` и отдаётся `502`.

*Про `PANEL_MAX_UNCOMPRESSED_MB=0`.* Прежний `int()` возвращал `0`, сравнение
`totalBytes > maxBytes` становилось заведомо ложным, и лимит **исчезал**: ноль
не «отключал» защиту, а ломал её. То же с `config.json` — он подставлял числа
«как есть».

*Про `setStatusIf` (P-26) и монитор.* `monitor.checkSite` писал статус напрямую,
поэтому первый тик (через 5 с после старта) мог записать `crashed` живому сайту,
который панель ещё не успела поднять: `boot()` вызывался ПОСЛЕ
`monitor.start()`. Порядок исправлен, переходы статуса — через `setStatusIf`.

*Проверка перед выкладкой на боевой стенд.* Сайты жили в **том же** systemd-cgroup,
что и панель (`/system.slice/sitepanel.service`, `KillMode=control-group`);
проверено чтением `/proc/<pid>/cgroup`. Значит перезапуск службы забирает и
сайты, сирот с занятыми портами на боевом стенде не возникнет. На новом стенде
панель в момент проверки была `inactive` (остановлена внешним `SIGTERM` в
20:58) — поднята до выкладки.

**Изменения.** Все правки — в рабочей копии `D:\Projects\SitePanel`, выложены на
оба стенда.

*Новые модули:*

- `D:\Projects\SitePanel\src\instancelock.js` — замок единственного экземпляра
  (`config.instanceLockFile` = `data/sitepanel.lock`, `src/config.js:74`):
  атомарная запись `tmp`+`rename` (`0600`), проверка живого pid (`kill(pid, 0)`,
  `EPERM` = жив), протухший замок перезаписывается, чужой хост считается занятым.
  Берётся в `src/index.js:30` **до** `ensureDirs()` и снимается в `shutdown`
  (`src/index.js:170-172`) и в `main().catch()` (`src/index.js:208-210`).
- `D:\Projects\SitePanel\src\sites\proc.js` — pid-файлы (`config.logsDir/<id>.pid`,
  **не** в каталоге сайта: он подменяется при деплое), сверка владельца порта
  (`matchesPidFile`: pid + cmdline + время старта), определение pid'ов на порту
  БЕЗ `lsof` (`portPidsViaProc` — разбор `/proc/net/tcp` + readlink
  `/proc/<pid>/fd`), проба `listen` и `connect` (`portBusy`, `portAnswers`).
- `D:\Projects\SitePanel\src\sites\sitelog.js` — асинхронная запись логов
  (`fs.createWriteStream`, `MAX_PENDING_BYTES` = 4 МБ), чтение **только хвоста**
  (`readLogTail` через `openSync`/`fstatSync`/`readSync` окном
  `min(logTailMaxBytes, max(4096, lines*400))`), ротация на N поколений
  (`logGenerations`).
- `D:\Projects\SitePanel\src\sites\deploymark.js` — маркеры деплоя
  (`data/tmp/deploy-<id>.json`, атомарно, `0600`) и реконсиляция при старте
  (`reconcile`): если каталога сайта нет, а `.backup` есть — каталог
  восстанавливается из `.backup`; `cleanTemp(maxAgeMs = 24 ч)` сносит брошенные
  staging/загрузки, НЕ трогая активные маркеры.

*Правки существующих файлов:*

- `D:\Projects\SitePanel\src\config.js` — все числовые пределы переведены на
  `posInt(v, dflt, min, max)` (`src/config.js:125`): значение вне диапазона — в
  том числе `0` и отрицательное — заменяется значением по умолчанию с
  предупреждением. Добавлены `deployTimeoutMin` (30 мин), `gitTimeoutMin` (5),
  `proxyTimeoutMs` (60000), `appListenWaitMs` (10000), `logMaxBytes` (4 МБ),
  `logGenerations` (3), `logTailMaxBytes` (256 КБ), `cmdOutputMaxBytes` (256 КБ),
  `instanceLockFile`. `config.json` проходит ту же проверку границ
  (`USER_CONFIG_RANGES`, `src/config.js:81-90`).
- `D:\Projects\SitePanel\src\sites\manager.js` — `extractZip` больше не доверяет
  заголовку: своя `inflateBounded(entry, budget)` (собственный `crc32`,
  `zlib.inflateRawSync` с `maxOutputLength`, сверка фактической длины с
  заявленной, отказ `BAD_SIZE`), отказ при превышении числа записей ДО создания
  каталога; `assertInside` экспортирован наружу; `gitClone` получил `detached`
  и независимое от `close` завершение промиса (`GIT_CLOSE_GRACE_MS` = 5000);
  `_start` обёрнут в `try/catch` вокруг `attemptStart()` (синхронный бросок
  `spawn` давал `500` вместо `crashed`); `_stop` не отбрасывает результат
  `ensurePortFreed` (был ложный успех при чужом процессе на порту);
  `ensurePortFreed` убивает только свои процессы (`P-18`); `waitListening`
  проверяет, что приложение реально открыло порт; `setStatusIf` для переходов;
  `deployBegin`/`deployEnd` в `boot`; неиспользуемый `auxProcesses` удалён.
- `D:\Projects\SitePanel\src\sites\deployfiles.js` — реестр живых подпроцессов
  деплоя (`activeCommands`, `killActiveCommands`) + allow-list окружения сборки
  (`siteEnv`, `PASSTHROUGH_KEYS`), общий бюджет установки/сборки (`deadline`).
- `D:\Projects\SitePanel\src\httpserver.js` — `createProxyServer({ xfwd: true,
  proxyTimeout: config.proxyTimeoutMs })` (опция `timeout` **убрана**, см.
  «Диагностику»); ветка `503` с `Retry-After` во время деплоя.
- `D:\Projects\SitePanel\src\index.js` — `await manager.boot()` ПЕРЕД
  `monitor/dashboard/alerts/acme` (`src/index.js:123-128`), снятие замка в
  `shutdown`, `killActiveCommands('SIGTERM')` при остановке.
- `D:\Projects\SitePanel\src\monitor.js` — `statsFor` читал `proc.child.pid` без
  защиты; у подхваченного (external) процесса `child === null`, поэтому карточка
  сайта отвечала `500 Cannot read properties of null (reading 'pid')`. Теперь
  `const pid = proc.child ? proc.child.pid : proc.pid;`.
- `D:\Projects\SitePanel\src\admin\routes.js` — распаковка архива при загрузке
  требует явного подтверждения (`extract=1` без `confirm=1` → `400`, файл не
  распакован и не потерян).
- `D:\Projects\SitePanel\src\admin\public\app.js` — оболочка шлёт `confirm=1`
  вместе с `extract=1` после диалога подтверждения.
- `D:\Projects\SitePanel\tests\helpers\panel.js` — `killPortListeners` больше не
  убивает собственный процесс тест-раннера (`lsof` возвращал его pid, когда тест
  сам слушал порт: прогон обрывался на середине файла).
- Новый файл `D:\Projects\SitePanel\tests\durability.test.js` — 31 тест этапа 2
  (T-05, T-06, T-09…T-11, T-13, T-30…T-34, T-40…T-45, H-06, P-26, P-31, SP-05,
  M-01).

**Проверка.**

- Полный набор `node tests/run.js`: на `141.133.197.43` (Node v22.22.1) —
  **`# tests 158 / # pass 156 / # fail 0 / # cancelled 0 / # skipped 2`**; на
  `46.29.164.250` (Node v20.20.2, версия боевого стенда) — те же
  **`156/158, 0 fail, 2 skipped`**. Две «скипнутые» — T-12 и T-33: явные
  заглушки, их покрытие лежит в `tests/gitvalidate.test.js` и
  `tests/proxy-security.test.js`.
- Мутационная проверка (`D:\Projects\SitePanel\.vps\stage2-mutate.cjs`, запуск
  `PANEL_ROOT=<каталог> node stage2-mutate.cjs`): ломает каждую защиту этапа по
  очереди, требует, чтобы замена **действительно применилась**, считает базовую
  линию и различает «пропущено» и «эквивалентно». Итог: **поймано 19,
  эквивалентных 4, пропущено 0, ошибок 0**. Эквивалентные четыре: три по
  `gitClone` (`detached`+`killTree` и `exit`+`graceTimer` — две независимые
  страховки завершения промиса, каждой одной достаточно) и одна по
  `child.on('error')` (при `shell: true` асинхронная ошибка достижима только
  когда недоступен сам `/bin/sh`; при недоступном `cwd` бросок синхронный и
  ловится `try/catch`). Обоснование каждой — в самом скрипте. Контрольные суммы
  `src/` после прогона совпали с рабочей копией, вхождений слова `mutation` не
  осталось.
- **Критерий готовности** (харнесс `D:\Projects\SitePanel\.vps\readiness-stage2.cjs`,
  прогон на выложенном коде в `/root/deploy-check`):
  * Часть 1 — 20 деплоев с `SIGKILL` посреди каждого: `killedMidDeploy: 20`,
    `reconcileLost: 0`, `dirMissingAtKill: 1`, **`lost: 0`**; финальный статус
    сайта `running`/`stopped`, каталог на месте, `index.html` на месте.
  * Часть 2 — перезапуск панели при живом сироте: сирота `119083` продолжает
    слушать порт, после перезапуска **новых процессов на порту 0**, pid-файл
    совпал с прежним, статус в реестре `running`, порт отвечает `200`.
  * Часть 3 — запрос во время деплоя: **`6/6` проб получили `503` с заголовком
    `Retry-After`** (6…10 с).
- Выкладка (`D:\Projects\SitePanel\.vps\deploy-stage2.sh`): порядок — сначала
  новый стенд `141.133.197.43`, затем боевой `46.29.164.250`; каталог `data/`
  не трогался. Бэкапы кода:
  `/root/sitepanel-code-backup-20261013-003840.tar.gz` (новый стенд, 48 файлов)
  и `/root/sitepanel-code-backup-20261012-213956.tar.gz` (боевой). Откат:
  `systemctl stop sitepanel && tar xzf <архив> -C /opt/sitepanel && systemctl start sitepanel`.
- Сверка md5 `src/` на трёх сторонах (рабочая копия, оба стенда) — совпали все
  проверенные файлы, в том числе `src/sites/manager.js ff89901c740f0f3dc7d574373df47170`,
  `src/index.js 0f3cf7127476d1874d212056bc8f0e77`,
  `src/httpserver.js 443cc60ffd623e43b763b3a01af90248`,
  `tests/durability.test.js ace9d8b67943a802482f6fe522cfb155`.
- Служба после выкладки на обоих стендах `active`; слушатели `127.0.0.1:3100`,
  `*:8080`, `*:8443`, а также внутренние порты сайтов.
- Размещённые сайты: `https://pqr.evil-mesh.ru` — **200**,
  `https://m.evil-mesh.ru` — **401** (штатная Basic-авторизация MeshCentral),
  `https://pg.evil-mesh.ru` — **200**, админки `https://panel.evil-mesh.ru` и
  `https://beget.evil-mesh.ru` — **401**.
- Проба `SP-08` на живом боевом стенде: попытка запустить второй экземпляр
  (`PANEL_ADMIN_PORT=13999 …`) отклонена сообщением «Уже запущен другой экземпляр
  панели (pid 392161 на r1114848, процесс уже работает)».
- Проба XSS на выложенном коде: `GET /%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E` —
  `404`, вхождений `onerror=alert` — 0; `Host: <b>injected</b>.evil` — `404` без
  подстановки разметки.

**Осталось.**

- Этап 2 закрыт; этап 3 (`PLAN.md`:1848-1868) не начат.
- **`db.json` изменился при выкладке** на обоих стендах (новый стенд
  `005df7c825e28d21aad278cdacff8615` → `c7ac8fe207ad826fbfe048a7fa35befc`;
  боевой `c528cc2b63ddb4cd91d12709c976dec7` → `4dbcd58eb0a71984572ab0e7c220f0d3`).
  Это штатное поведение нового кода, а не потеря: рядом появилась предыдущая
  копия `db.json.bak`, а в записи добавились нормализованные поля (`health`,
  `restartCount`, `fails`). Состав сайтов, их id, порты, домены и `autoStart`
  не изменились — проверено чтением файла, оба сайта `running`. `auth.json` на
  обоих стендах не изменился.
- Каталог данных разбора критерия готовности остался в `/tmp/sp-ready-GCoqc6`
  (не удалялся намеренно — на случай разбора).
- Версия в `package.json` осталась `1.0.1`, изменения — в `[Unreleased]`
  `CHANGELOG.md`. Отдельным решением нужно решить, каким тегом их выпускать.
- Тесты этапа 2 требуют `adm-zip` 0.6.1 и работают только на сервере: локальный
  `node_modules` рабочей машины содержит устаревший 0.5.18.

---

## 2026-10-12 — Этап 1 плана: сохранность данных, экранирование, вход в админку; выкладка на оба стенда

**Запрос.** (m02433) «Начнем по плану с п1» — выполнить этап 1
[PLAN.md](PLAN.md):1783-1802 («Сохранность данных и безопасность», P0), задачи
1.1…1.11, с критериями готовности из того же раздела.

**Диагностика.** Работа шла по уже собранному аудиту (см. запись про `PLAN.md`),
поэтому ниже — только то, что выяснилось **в ходе** этапа и меняло решение.

*Блокер, найденный до выкладки:* `D:\Projects\SitePanel\src\auth.js` в релизе
1.0.1 считал `scrypt` с параметрами по умолчанию (`N=16384`) и **не писал
параметры в `auth.json`** — там только `user`, `salt`, `hash`. Новый код поднял
параметры до `N=32768` (задача 1.6). Если бы он читал прежние файлы новыми
параметрами, хеш никогда бы не совпал, и на **каждом существующем стенде** верный
пароль перестал бы подходить — обновление панели отрезало бы доступ к самой
панели. Проверено на живых файлах: `/opt/sitepanel/data/auth.json` на
`141.133.197.43` и на `46.29.164.250` — ключи `['hash','salt','user']`, поля
`params` нет. Правки: параметры, с которыми посчитан хеш, теперь хранятся рядом
с ним (`params`), файл без `params` читается по `LEGACY_SCRYPT_OPTS` (`N=16384`),
а после **успешного** входа хеш пересчитывается и файл получает `params`
(`src/auth.js:206-234`, `src/auth.js:331-348`).

*Второй дефект, найденный тестом:* `validateGitUrl` знал только форму
`owner/repo` и **отклонял** легитимные GitLab/self-hosted адреса с вложенными
группами (`group/sub/repo`) — это функциональная поломка, а не строгость.
Регулярка переписана; дополнительно ни один сегмент пути не может начинаться с
`-`, иначе `git` принял бы его за флаг (например, `--upload-pack=…`).

**Изменения.** Все правки — в рабочей копии `D:\Projects\SitePanel`, выложены на
оба стенда.

- `D:\Projects\SitePanel\src\store.js` — fail-closed при порче реестра: битый
  `db.json` больше не даёт пустой список сайтов, а переводит панель в аварийный
  режим (`recoveryMode`, `src/store.js:39,143,168`), повреждённый файл
  откладывается, предыдущее поколение читается из `db.json.bak`
  (`src/store.js:156`), добавлена валидация записей (`validateSite`,
  `src/store.js:58`).
- `D:\Projects\SitePanel\src\auth.js` — асинхронный `scrypt` вместо
  синхронного, ограничение неудачных попыток и блокировка по IP
  (`PANEL_LOGIN_MAX_FAILS`=10, `PANEL_LOGIN_WINDOW_MS`=5 мин,
  `PANEL_LOGIN_LOCKOUT_MS`=15 мин, потолок одновременных проверок 2,
  задержка 500 мс, `src/auth.js:27-34`), кэш успешных проверок
  (`PANEL_AUTH_CACHE_MS`=60000, до 512 записей; пароль в памяти не хранится —
  ключ это `sha256(user \\0 password)`), разбор `Authorization` по **первому**
  `:`, чтобы пароль с двоеточием не усекался, `failHard` вместо перезаписи
  битого `auth.json` (`src/auth.js:167-185`).
- `D:\Projects\SitePanel\src\securefile.js` — `writePrivateAtomic`
  (`src/securefile.js:40`): временный файл рядом → `fsync` данных
  (`src/securefile.js:66`) → `rename` → `fsync` каталога
  (`src/securefile.js:85`).
- `D:\Projects\SitePanel\src\httpserver.js` — `esc()` (`src/httpserver.js:61`),
  корректный `hostOf` (отбрасывает имя целиком, если оно не подходит под
  `/^[a-z0-9._-]+$/`, и правильно разбирает IPv6-литерал `[::1]:8443`;
  `src/httpserver.js:75`), проверка пути через `realpath`
  (`realInside`, `src/httpserver.js:192`), проверка порта сайта перед
  проксированием, гарантированный ответ при ошибке потока.
- `D:\Projects\SitePanel\src\config.js` — `adminHost` по умолчанию `127.0.0.1`
  (`src/config.js:26`), каталоги данных создаются с режимом `0o700`
  (`src/config.js:81`).
- `D:\Projects\SitePanel\src\index.js` — идемпотентный `shutdown`
  (`src/index.js:21,117,121`) с эскалацией `SIGKILL` через 3 с и выходом через
  5 с, `try/catch` вокруг `store.flush()`, исправлено предупреждение
  `PANEL_NO_AUTH` (обращалось к несуществующему `config.host`).
- `D:\Projects\SitePanel\src\sites\manager.js` — `killTree` для убийства группы
  процессов (`src/sites/manager.js:128`), таймаут `git clone` с
  `GIT_TERMINAL_PROMPT=0`/`GIT_SSH_COMMAND` (`src/sites/manager.js:788`),
  `assertInside` через `path.relative` (`src/sites/manager.js:774`), `validateSubdir`
  запрещает `..`, `.` и абсолютные пути, `removeSite`/`_rollback` не удерживают
  блокировку и откатываются через `swapWithBackup`.
- `D:\Projects\SitePanel\src\sites\lock.js` — очередь освобождается в `finally`
  (`src/sites/lock.js:38`), повторный вход в блокировку отклоняется.
- `D:\Projects\SitePanel\src\ssl\certs.js` — подпись самоподписанного
  сертификата `sha256` (`src/ssl/certs.js:32`).
- `D:\Projects\SitePanel\src\admin\routes.js` — валидация `user` в
  `POST /api/password`, `401` вместо `500` на кривую `Authorization`, JSON-404
  для `/api/*` вне SPA-fallback.
- Новые тесты: `D:\Projects\SitePanel\tests\store.test.js`,
  `D:\Projects\SitePanel\tests\lock.test.js`,
  `D:\Projects\SitePanel\tests\proxy-security.test.js`,
  `D:\Projects\SitePanel\tests\gitvalidate.test.js`,
  `D:\Projects\SitePanel\tests\auth-extended.test.js`,
  `D:\Projects\SitePanel\tests\auth.test.js`,
  `D:\Projects\SitePanel\tests\extract.test.js`,
  `D:\Projects\SitePanel\tests\tls.test.js`; хелпер
  `D:\Projects\SitePanel\tests\helpers\panel.js` (в нём добавлен параметр
  `opts.auth`, потому что тесты, подкладывающие свой `auth.json`, не получают
  баннера первого запуска и иначе не могут узнать пароль).

**Проверка.**

- Полный набор тестов: `node tests/run.js` в `/root/stage1-src` на обоих стендах —
  **`# tests 127 / # pass 127 / # fail 0 / # cancelled 0 / # skipped 0`**
  (на `141.133.197.43` Node v22.22.1, на `46.29.164.250` Node v20.20.2 —
  то есть набор зелёный и на той версии, что стоит в бою).
- Мутационная проверка (`D:\Projects\SitePanel\.vps\stage1-mutate.cjs`,
  запуск `PANEL_ROOT=<каталог> node stage1-mutate.cjs`): ломает каждую защиту по
  очереди, требует, чтобы замена **действительно применилась**, и проверяет, что
  тесты это ловят. Итог: **поймано 17, эквивалентных 1, пропущено 0, ошибок 0**.
  Эквивалентная мутация одна — `esc()` вокруг уже отфильтрованного `hostOf`
  значения; она не меняет поведение, и это объяснено в самом скрипте. Каждый
  прогон оставил файлы восстановленными: контрольные суммы `src/` совпали с
  рабочей копией.
- Замер критерия готовности (8 параллельных авторизованных запросов к админке
  против отклика сайта; `D:\Projects\SitePanel\.vps\bench-admin-auth.cjs`), на
  **выложенном** стенде `141.133.197.43`: контроль медиана 1.84 мс / p95 2.78;
  под нагрузкой медиана 1.98 / p95 3.48; **ухудшение медиана ×1.08, p95 ×1.25**
  при пороге «не более 2×» — **OK**; 224 запроса к админке, 0 ошибок.
  Для сравнения, на прежнем коде тот же замер давал p95 ×113.78 при отклике
  админки p50 498 мс.
- Совместимость учётных данных прежнего формата — сквозная проба через HTTP
  (`D:\Projects\SitePanel\.vps\probe-legacy-login.sh`): создаётся `auth.json` в
  формате релиза 1.0.1 (хеш по `N=16384`, без `params`), панель поднимается на
  новом коде, вход верным паролем даёт **200**, файл получает
  `params {"N":32768,"r":8,"p":1}`, повторный вход — снова **200**, неверный
  пароль — **401**. Прогнано и на `141.133.197.43`, и на `46.29.164.250`.
- Выкладка (первым — новый стенд, затем боевой; `D:\Projects\SitePanel\.vps\deploy-stage1.sh`):
  перед заменой кода снят архив, каталог `data/` не трогался — контрольные суммы
  `db.json` и `auth.json` до и после замены совпали. Бэкапы кода:
  `/root/sitepanel-code-backup-20261012-185408.tar.gz` (новый стенд),
  `/root/sitepanel-code-backup-20261012-160238.tar.gz` (боевой). Откат —
  `systemctl stop sitepanel && tar xzf <архив> -C /opt/sitepanel && systemctl start sitepanel`.
- После перезапуска на обоих стендах: служба `active`; слушатели
  `127.0.0.1:3100` (админка теперь только на loopback) и `*:8080`/`*:8443`;
  запрос без пароля на `/api/system` и на `/` — **401** (раньше оболочка UI
  отдавалась анонимно).
- Размещённые сайты после выкладки: `https://pg.evil-mesh.ru` — **200**;
  `https://pqr.evil-mesh.ru` — **200**; `https://m.evil-mesh.ru` — **401** от
  самого приложения (MeshCentral Monitor требует Basic, это его штатное
  поведение, не регрессия); админки `https://beget.evil-mesh.ru` и
  `https://panel.evil-mesh.ru` — **401**.
- Проба XSS, которую закрывает этап: `GET /%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E`
  на порту 8443 с `Host: pg.evil-mesh.ru` — тег в ответе **не исполняется**
  (вхождений `onerror=alert` — 0), заголовок `Content-Security-Policy:
  default-src 'none'` присутствует. Заголовок `Host: <b>injected</b>.evil`
  даёт заглушку «не привязан» без подстановки разметки.

**Осталось.**

- Этап 1 закрыт; этапы 2 и 3 (`PLAN.md`:1804-1860) не начаты.
- Версия в `package.json` осталась `1.0.1`, изменения — в `[Unreleased]`
  `CHANGELOG.md`. Отдельным решением нужно решить, каким тегом их выпускать.
- Автоматическая проверка «реверс-прокси держит отклик под нагрузкой на вход»
  выполнялась вручную скриптом; в набор тестов она не встроена (замер требует
  двух процессов и стабильного стенда).
- На боевом стенде `46.29.164.250` после перезапуска в журнале службы видно
  `Права на секреты обновлены: 1 файл(ов)` — это штатная нормализация прав
  каталога `data/`; содержимое файлов при этом не менялось (контрольные суммы
  совпали).

---

## 2026-10-12 — Аудит узких мест панели и план улучшений (`PLAN.md`)

**Запрос.** (m01035) «Оцени все узкие места панели, напиши план по улучшениям и
справлениям». Требовался аудит кода панели с проверками на живых стендах и
письменный план исправлений. **Код панели в ходе этой задачи не менялся.**

**Диагностика.** Объём: `src/` — 18 файлов, 4911 строк; `tests/` — 11 `.test.js`
+ раннер `run.js`, 61 тест. Аудит вёлся по 5 областям (данные/персистентность;
процессы и деплой; HTTP, прокси и ACME; аутентификация и секреты; мониторинг,
алерты, дашборд; админ-UI; тесты) и дополнялся собственными замерами на обоих
стендах.

Проверено и воспроизведено (ключевое):

- `D:\Projects\SitePanel\src\store.js:27-36` — `load()` ловит ошибку разбора
  **голым** `catch { /* первый запуск */ }`; обрезанный `db.json` даёт `sites: []`,
  а первая же мутация через `flush()` (`src/store.js:43-50`) **перезаписывает
  единственную копию** пустым состоянием. Воспроизведено на изолированном
  каталоге данных: после `PUT /api/settings` реестр из 2 сайтов уничтожен,
  каталоги сайтов на диске остались «ничьими». Бэкапа повреждённого файла нет.
- `D:\Projects\SitePanel\src\auth.js:40` — `crypto.scryptSync` на **каждый**
  запрос к админке. Замер на стенде `141.133.197.43` (2 vCPU): **52.2 мс** на
  вызов; 20 параллельных запросов с паролем — **2.136798 с**, без пароля —
  **0.098284 с**. Тот же event loop обслуживает реверс-прокси: 8 авторизованных
  запросов к админке подняли отклик сайта с **0.000890 с** до **0.320018 с**
  (**в 360 раз**). Rate limit, lockout и логирование неудачных попыток
  отсутствуют (`fail2ban` следит только за `sshd`, в nginx нет `limit_req`).
- `D:\Projects\SitePanel\src\httpserver.js:63-71,160-161` — `page(title, body)`
  подставляет `${title}`/`${body}` и `${host}` **без экранирования**.
  **Доказан сквозной XSS из интернета** через путь (а не через `Host`):
  `GET /%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E` при корректном `Host`; nginx
  такой путь проксирует, `src/httpserver.js:100` делает `decodeURIComponent`, и
  заглушка 404 статического сайта возвращает **декодированный** тег **без CSP**.
  Для доказательства временно создавались статический сайт (`id 03c73de0371d`) и
  nginx-вхост; **оба удалены**, стенд проверен (`sites` = только `pg`).
  Вектор через `Host` локально реален (`curl` вернул теги), но **снаружи режется
  nginx** (80/443 → `400 Bad Request`).
- `D:\Projects\SitePanel\src\sites\manager.js:728-734` — `validateSubdir`
  допускает `..` (`../../sites/<id>`), что позволяет **вынести каталог чужого
  сайта**. Воспроизведено на изолированном дереве с той же арифметикой путей.
- `D:\Projects\SitePanel\src\sites\manager.js:441-449` — защита от zip-бомбы
  суммирует `e.header.size` из **центрального каталога** (управляется атакующим),
  а `adm-zip` ставит `maxOutputLength` только при `expectedLength > 0`
  (`node_modules/adm-zip/inflater.js:5`). Замерено: архив с 400 МБ содержимого
  занял **398 КБ** при заявленном размере `0`, проверка дала **`PASS`** при лимите
  2048 МБ, при распаковке RSS вырос до **1270 МБ** (падение на CRC32). Ущерб —
  расход памяти панели, **на диск мусор не пишется** (`getData()` предшествует
  записи).
- `D:\Projects\SitePanel\src\httpserver.js:130-133` — прокси на `site.port = null`
  **не отвечает и не ошибается** (`proxy.web` вернулся, события `error` нет,
  клиент повис) — утечка сокетов до отказа панели.
- Жизненный цикл сайта (подкоманда B, отчёт `m02225`/`m02226`; уточнено чтением
  кода — `manager.js` **958** строк, `src/` — 4911):
  - `src/sites/manager.js:60-70` — `allocatePort()` читает только **сохранённые**
    `site.port`; записи сайтов созданы с `port: null`
    (`src/admin/routes.js:141`), порт выдаётся уже внутри `finalizeDeploy`
    (`:594`), лок — **на сайт**. Два параллельных деплоя `node`-сайтов получают
    **один и тот же порт 10000**; проверки занятости на уровне ОС нет (`P-17`).
  - `src/sites/manager.js:378-397` — `ensurePortFreed` убивает `SIGKILL` **любой**
    процесс на порту, кроме своего PID (`:384`), без проверки принадлежности
    сайту → вместе с `P-17` это межсайтовое убийство (`P-18`).
  - `src/sites/manager.js:276,315-320` — `_stop` ставит `stopped` до подтверждения
    смерти и **отбрасывает** результат `ensurePortFreed`; на машине без `lsof`
    (`:370` → `err` → `[]`) «остановлен» — фикция, следующий старт ловит
    `EADDRINUSE` (`P-19`).
  - `src/sites/manager.js:833-850` — `_rollback` делает `rmSync(dir)` (`:839`) и
    только затем `renameSync(backup, dir)` (`:840`): не атомарно, текущая версия
    не сохраняется, при сбое второго шага каталог сайта исчезает (`P-20`).
  - `src/sites/manager.js:154,658-660` — `PORT: String(site.port)`: `_rollback`/
    `startAfterDeploy` переопределяют тип и команду, но **не порт**; `node`-сайт с
    `port = null` слушает Unix-сокет `null` и не занимает TCP, а прокси уходит на
    `http://127.0.0.1:null` (`P-21`, связано с `P-14`).
  - `src/sites/deployfiles.js:55-83` — `spawn(..., { shell:true })` **без**
    `detached`, поэтому `process.kill(-child.pid, 'SIGKILL')` (`:78`) адресует
    несуществующую группу; доказано: без `detached` `process.kill(-pid, 0)` →
    `ESRCH`. По таймауту умирает только `sh`, а `npm`/`node`/`postinstall`
    продолжают жить и писать в уже переименованный каталог (`P-22`).
  - Три неограниченных буфера: `all += text` (`src/sites/deployfiles.js:87`),
    `errOut += …` (`src/sites/manager.js:742`), `fs.readFileSync` всего лога в
    `readLogTail` (`src/sites/manager.js:48-56`) — `GET /logs?lines=1` на логе
    3 ГБ аллоцирует 3 ГБ (`P-23`).
  - `src/sites/manager.js:736-752` — у `git clone` **нет таймаута** и открыта
    stdin-труба; git, спрашивающий логин, висит вечно и держит `withSiteLock`
    сайта навсегда (все start/stop/deploy/delete этого сайта встают в очередь,
    при перезапуске — и `boot()`) (`P-24`).
  - `src/index.js:63-84` — окно завершения **1200 мс**, таймеры
    `restartTimer`/`cooldownTimer`/`stableTimer` не гасятся; внуки переживают
    выход и держат порты, а `boot()` (`src/sites/manager.js:854-867`) поднимает
    сайты с `manual:true`, то есть **сбрасывает бэкофф** каждому `crashed`-сайту
    при каждом перезапуске панели (`P-25`).
  - `src/sites/manager.js:144-165` — `setStatus(site,'starting')` стоит **до**
    `attemptStart()`; при piped stdio `spawn` бросает **синхронно**, если исчез
    `cwd`, и бросает именно подписка на `child.stdout` (`:167`). Ошибка уходит
    как HTTP 500, статус навсегда остаётся `starting` (`P-27`).
  - `src/sites/manager.js:922-930` — `forgetSiteLock` вызывается в `finally`
    **внутри** ещё удерживаемой блокировки; следующий запрос по тому же id
    стартует новую цепочку и идёт параллельно с разворачивающимся удалением
    (`P-28`), а неудачные создания сайта (`src/admin/routes.js:151-157,187-192`)
    оставляют в `chains` вечную запись (`P-29`).
- `D:\Projects\SitePanel\src\admin\public\style.css:241` — `.panel .span2` это
  **потомок**, а в разметке (`app.js:490,499,1045`) `panel` и `span2` — классы
  **одного** элемента; замерено в Chromium: `matches('.panel .span2') === false`,
  панели занимают 49.6 % ширины вместо всей.
- `D:\Projects\SitePanel\src\admin\public\app.js:465` — `#domainList` никогда не
  заполняется: домены сайта не видны и не отвязываются из UI, хотя маршрут
  `DELETE /api/sites/:id/domains/:domain` (`src/admin/routes.js:281-287`) есть.
- Первые редакции четырёх находок были неточными и **исправлены замером**:
  `U-02` (ячейки истории 0×0, а не «слипаются»), `U-04` (доступность модальных
  окон в основном **сделана**: `role="dialog"`, `aria-modal`, ловушка фокуса,
  возврат фокуса, `Escape` уважает `busy` — дыра только в закрытии по подложке),
  `H-01` (два вектора разной достижимости), `P-15` (память, а не диск).

**Изменения.**

- Создан **`D:\Projects\SitePanel\PLAN.md`** (2003 строки, 185 252 байта) — реестр
  находок и план работ:
  - раздел 1 — сводка: **7 CRITICAL · 38 HIGH · 52 MEDIUM · 6 LOW = 103** позиции
    плюс адресные пробелы в тестах (`T-05`…`T-45`);
  - раздел 2 — реестр по подразделам 2.1–2.10 (с точными путями, номерами строк,
    командами и замерами; пометки достоверности **[пр.]**/**[код]**/**[оц.]**);
  - раздел 3 — 7 этапов работ с привязкой задач к ID находок;
  - разделы 4–7 — порядок выкладки и проверки, сознательно принятые риски,
    список из 19 проверенных и признанных исправными механизмов, оценка объёма.
- Убраны посторонние файлы, оставшиеся в корне репозитория от прогонов проб
  (созданы не вручную, а скриптами проверок): `tmp_probe1.js`,
  `tmp_probe_als.js`, `tmp_probe_als2.js`, `tmp_probe_bomb.js`,
  `tmp_probe_bomb2.js`, `tmp_probe_final.js`, `tmp_probe_paths.js`,
  `tmp_probe_pgid.js`, `tmp_probe_proxy.js`, `tmp_probe_proxy_git.js`,
  `tmp_probe_spawn.js`, `tmp_probe_stdio.js`, `tmp_git_err.txt`,
  `PLAN.md.bak-reorder`. Их выводы зафиксированы в `PLAN.md`, описание — в
  `D:\Projects\SitePanel\.vps\audit-probes\README.md` (каталог в `.gitignore`).
- Временный статический сайт `03c73de0371d` и nginx-вхост `xssprobe`, созданные
  для доказательства сквозного XSS, **удалены**.

**Проверка.**

- `node .vps\count-plan.mjs` + `node .vps\xref-plan.mjs` + `node .vps\lint-plan.mjs`
  — сверка документа: подсчёт по разделам совпал с таблицей раздела 1 до единицы
  (`SP 1/7/4/2=14`, `P 2/14/16/1=33`, `H 0/8/12/1=21`, `A 0/3/2/1=6`,
  `M 0/1/6/0=7`, `U 0/3/8/1=12`, `I 0/2/4/0=6`, `T 4`; **итого 7/38/52/6=103**);
  все 103 находки упомянуты в разделе 3, неразрешённых ссылок на ID — 0;
  таблиц с ошибками — 0, секретов — 0, CRLF и хвостовых пробелов нет,
  всего 2003 строки; `md5` документа — `b609cf237984b799afe2c645e4b7f7f8`.
- Стенд `141.133.197.43` после доказательства XSS проверен: `sites` = только
  `pg` (`88b1b76605e9`, `pg.evil-mesh.ru`), каталог `data/sites/` содержит только
  `88b1b76605e9`, `sites-available`/`sites-enabled` без `xssprobe`,
  `data/tmp` пуст, `sitepanel`/`nginx`/`fail2ban` — `active`.
- Секреты в `PLAN.md` не попадают: пароли и токены упоминаются только как `***`
  или не упоминаются вовсе; в `.vps/` (в `.gitignore:24`) лежат скрипты с
  паролем панели в открытом виде — каталог в репозиторий не идёт.

**Осталось.**

- Решение пользователя: какие этапы плана брать в работу и в каком объёме.
- Этап 1 плана (`PLAN.md`, раздел 3) рекомендован первым: `SP-01` (тихая потеря
  `db.json`), `H-01` (XSS), `A-01` (DoS на входе). Сразу за ним — этап 2, где
  лежат самые разрушительные деплойные находки: `P-11` (увод каталога чужого
  сайта через `subdir`), `P-17` (два сайта на одном порту) и `P-18`
  (`SIGKILL` чужому процессу по порту).
- Этапы 5 и 7 затрагивают доступ и работу размещённых сайтов (`pqr`, `m`, `pg`)
  либо внешние зависимости — требуют отдельного согласия.
- `node-forge` GHSA-86w9-cpqp-85rv остаётся принятым риском (исправленной версии
  нет, достижимость в панели не подтверждена).
- Смена `ENCRYPTION_SECRET` у сайта `pg` сделает уже сохранённые пароли БД в
  `users/Admin/configs.json` нерасшифровываемыми — требуется решение.
- Внешняя БД `92.101.71.244:5432` недоступна с обоих стендов (TCP timeout) —
  состояние до работ, к публикации отношения не имеет.

---

## 2026-10-12 — Сайт `pg.evil-mesh.ru` опубликован из репозитория `pogpure3/pqr`

**Запрос.** (m00802) «в новой панели опубликуй сайт https://github.com/pogpure3/pqr
токен гитхаб возьми с первого сервера, домен pg.evil-mesh.ru». Новый стенд —
`141.133.197.43`, «первый сервер» — старый стенд `46.29.164.250`, где уже работает
тот же репозиторий под именем `pqr` (`pqr.evil-mesh.ru`). Отдельным уточнением
(m00881) пользователь выбрал перенос `.env` и `users/` со старого стенда.

**Диагностика.** Проверено до изменений:

1. **Токен GitHub лежит в БД панели старого стенда.** В `data/db.json` запись сайта
   `pqr` (`238b5bbfec01`) содержит поле `gitToken` длиной 93 символа с префиксом
   `gith` — то есть fine-grained PAT. Панель хранит его отдельно от `gitUrl` и наружу
   через API не отдаёт (`src/sites/manager.js:818`, `src/admin/routes.js:203`).
   Токен прочитан чтением `db.json` и передан в новый деплой как есть; в журнал не
   попадает.
2. **Репозиторий без `.env` и `users/` не работает.** Оба пути в `.gitignore`
   репозитория. `server.js` при отсутствии/дефолтном `JWT_SECRET` делает
   `process.exit(1)`, а каталог `users/` хранит учётку `Admin` (роль admin
   зарезервирована за этим именем, `services/users.js:22`). Регистрация в приложении
   открыта и не ограничена первым запуском: без перенесённого `users/` любой
   посторонний мог занять имя `Admin` и получить права администратора.
   В `users/` на старом стенде: `Admin.json`, `Admin/{widgets,configs,queries}.json`.
3. **DNS уже настроен.** `pg.evil-mesh.ru A 141.133.197.43` (проверено
   `Resolve-DnsName`); зона `evil-mesh.ru` на `ns1.timeweb.ru`, `ns2.timeweb.ru`,
   `ns3.timeweb.org`, `ns4.timeweb.org`. Правок DNS не требовалось.
4. **Внешняя БД недоступна и со старого стенда.** `PG_HOST` из перенесённого `.env` —
   `92.101.71.244:5432`: TCP-соединение даёт **таймаут** и с нового, и со старого
   стенда. Это существующее состояние стенда, не регрессия публикации: приложение
   поднимается и работает, недоступен только сам сервер БД в момент проверки.
5. **Порты и ресурсы.** Сайт занял `10000` (`PANEL_INTERNAL_PORT_FROM=10000`,
   `src/config.js:32`). На новом стенде `git 2.53.0`, `node v22.22.1`, `npm 9.2.0`.

**Изменения.** Все — только на новом стенде `141.133.197.43`.

- **Сайт заведён штатным API панели** (не правкой файлов):
  `POST /api/sites/git {"url":"https://github.com/pogpure3/pqr.git","name":"pg","token":"***","autoStart":false}`.
  Результат: `id 88b1b76605e9`, `type node`, `port 10000`, `startCommand npm start`.
  Зависимости установлены панелью (`added 204 packages`, `npm ci` по lock-файлу не
  прошёл и был повторён без `--frozen-lockfile` — штатная ветка `npmInstall`).
- **Перенесены пользовательские данные** из `/opt/sitepanel/data/sites/238b5bbfec01`
  старого стенда в `/opt/sitepanel/data/sites/88b1b76605e9` нового: `.env` и каталог
  `users/`. Перенос `tar czf - .env users | base64` через рабочую машину, распаковка
  на месте. Права выставлены заново: `.env` → `600`, `users/` → `700`, файлы внутри → `600`.
  Контрольные суммы совпали (проверено `sha256sum` на обоих стендах):
  `.env` = `4cc36d644f2b046024597436d4af1b40ad379b028e821045bb14a68e7269eb3b`,
  `users/Admin.json` = `0a0ca6973b7056185647d02d0fa063d8eca9d682a360c70e628f928d22a006fa`,
  `users/Admin/widgets.json` = `859715c567e4b07806cc985ec00f29da3857a9c109987af55cd1b00b40a23971`,
  `users/Admin/configs.json` = `a0345ef47e382b08145e07e2ccf66c61dd6ced4bcd44f1a979d78ff7772e74c7`,
  `users/Admin/queries.json` = `fa9e19866d1d46d1452eeb23697587b7ba054011371968f4bde0d80f2b169844`.
- **Домен привязан, сайт запущен**: `POST /api/sites/88b1b76605e9/domains
  {"domain":"pg.evil-mesh.ru"}` → `{"ok":true}`, затем `POST .../start`. Автозапуск
  включён **методом `PATCH`** `PATCH /api/sites/88b1b76605e9 {"autoStart":true}` —
  первая попытка через `PUT` вернула `404` (маршрута нет, есть `PATCH`, `src/admin/routes.js:259`).
- **nginx-вхост `/etc/nginx/sites-available/pg`** + симлинк в `sites-enabled/pg`:
  блок `listen 80` (ACME + `301 https`), блок `listen 443 ssl` с
  `/etc/letsencrypt/live/pg.evil-mesh.ru/{fullchain,privkey}.pem`, `options-ssl-nginx.conf`,
  `ssl-dhparams.pem` и `location / { proxy_pass http://127.0.0.1:8080; }` с заголовками
  `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, `Upgrade`/`Connection`.
  Путь `/.well-known/acme-challenge/` обслуживает **два** сценария: `root /var/www/html`
  + `try_files $uri @panel_acme`, где `@panel_acme` проксирует на панель. Без fallback
  выпуск сертификата **из самой панели** для этого домена упирался бы в `404`.
- **Сертификат Let's Encrypt** выпущен `certbot certonly --webroot -w /var/www/html
  -d pg.evil-mesh.ru` → `/etc/letsencrypt/live/pg.evil-mesh.ru/`, `CN=pg.evil-mesh.ru`,
  issuer `Let's Encrypt YE2`, действует до `2027-01-10`. В
  `/etc/letsencrypt/renewal/pg.evil-mesh.ru.conf`: `authenticator = webroot`,
  `webroot_path = /var/www/html,` — продление не переписывает вхост.
  Затем для паритета со старым стендом сертификат выпущен **и через панель**:
  `POST /api/sites/88b1b76605e9/ssl/issue {"domains":["pg.evil-mesh.ru"]}` → `{"ok":true}`,
  `ssl.status=active`, `ssl.provider=letsencrypt`, файлы в
  `/opt/sitepanel/data/certs/88b1b76605e9/`.
- **Бэкапы nginx** (перед каждой правкой вхоста):
  `/root/nginx-backup-20261012-131138/` (полный `sites-available` + `sites-enabled` +
  `nginx.conf`), `/root/pg.nginx.bak.20261012-131252` (вхост после выпуска сертификата),
  `/root/pg.nginx.bak.20261012-131452` (вхост до добавления ACME-fallback).
  Каждый раз — `nginx -t` (`syntax is ok`, `test is successful`) и только затем `reload`.

**Проверка.** Проверено:

- **Снаружи, с рабочей машины** (node `fetch`, настоящая валидация TLS):
  `https://pg.evil-mesh.ru/` → `200`, 32314 байта, `<title>Postgres Query Runner</title>`;
  `/style.css` → `200` 53636 байт, `/script.js` → `200` 91441 байт,
  `/favicon.svg` → `200` 480 байт, `/api/health` → `200` `{"status":"ok","uptime":81}`;
  `http://pg.evil-mesh.ru/` → `301` на `https://pg.evil-mesh.ru/`.
- **Внутри стенда**: `https://pg.evil-mesh.ru/` → `200` с заголовком
  `X-Sitepanel-Site: 88b1b76605e9`; сертификат по SNI — `subject=CN=pg.evil-mesh.ru`,
  `notBefore=Oct 12 09:14:08 2026 GMT`, `notAfter=Jan 10 09:14:07 2027 GMT`.
- **Учётка `Admin` из перенесённого `users/` действительно используется**:
  `POST /api/auth/register {"username":"Admin",...}` → `400`
  `{"error":"Пользователь уже существует"}`, а `sha256sum users/Admin.json` после
  попытки не изменился. Проверка входа с намеренно неверным паролем →
  `401 {"error":"Неверное имя пользователя или пароль"}` — бэкенд жив и отвечает.
- **Автозапуск**: `systemctl restart sitepanel` → через 1 с сайт снова
  `status=running, running=true`, `journalctl -u sitepanel -p err` — пусто.
- **ACME-путь работает в обоих режимах**: файл из `/var/www/html/.well-known/acme-challenge/`
  отдаётся с диска (`тело: webroot-ok`), несуществующий токен уходит в fallback на
  панель и возвращает `404 challenge not found` (ответ самой панели).
- **Заглушки не сломались**: запрос по IP на 80 → соединение закрыто (`444`),
  неизвестный SNI → `unrecognized name`, `https://beget.evil-mesh.ru/` → `200`.
- **Службы**: `sitepanel`, `nginx`, `fail2ban` — `active`, `ufw` — `active`;
  память 1396 МБ свободно, диск `/` 5.9 ГБ из 28 ГБ (22%).

**Осталось.** Незакрытое и риски:

- **Внешняя БД `92.101.71.244:5432` недоступна** (таймаут TCP) — и с нового, и со
  старого стенда. Приложение стартует и отдаёт интерфейс, но запросы к БД не пройдут,
  пока сервер БД не ответит или не будет разрешён по файрволу. Действий не предпринимал:
  это состояние существующего стенда, вне рамок публикации. Нужно решение пользователя.
- **`JWT_SECRET` и `ENCRYPTION_SECRET` общие со старым стендом** — следствие выбранного
  переноса `.env`. Токен входа, полученный на `pg.evil-mesh.ru`, будет валиден и на
  `pqr.evil-mesh.ru` (и наоборот). Если домены должны быть изолированы, нужно выпустить
  новые секреты; при смене `ENCRYPTION_SECRET` сохранённые в `configs.json` пароли БД
  перестанут расшифровываться.
- **`/app.js` на `pg.evil-mesh.ru` отдаёт `404`** — это норма: приложение ссылается на
  `/script.js`, файла `app.js` в нём нет. Артефакт первой проверки, не дефект.
- Сертификат панели для сайта (`data/certs/88b1b76605e9`) и сертификат nginx
  (`/etc/letsencrypt/live/pg.evil-mesh.ru`) — **разные сертификаты**, как и на старом
  стенде: наружу TLS терминирует nginx, панельный сертификат используется её
  собственным HTTPS-портом 8443 и SNI. Продление nginx-сертификата — `certbot.timer`,
  панельного — цикл `startRenewalLoop` в `src/ssl/acme.js`.

---

## 2026-10-12 — Авторизация админки, права при распаковке zip, TLS-дефекты, зависимости и инфраструктура

**Запрос.** (m00225) «Исправь показ статистики админки без пароля на обоих серверах, закрой
незакрыто» — то есть закрыть интерфейс админки паролем и разобрать пункты «Осталось»
предыдущей записи (зависимости, swap, часовой пояс, заглушка для запроса по IP).
Работы выполнены и выложены на **оба** стенда: новый `141.133.197.43` и старый `46.29.164.250`.

**Диагностика.** Ниже — только проверенное, с указанием способа проверки.

1. **Оболочка админки отдавалась без пароля.** `GET /`, `/app.js`, `/style.css` →
   `200` **без** заголовка `Authorization`; `401` приходил только на `/api/*`.
   Причина: `auth.middleware` был навешен лишь в `src/admin/routes.js:22` (`router.use`),
   а `express.static` и SPA-fallback в `src/index.js` шли выше по стеку без защиты.
   Проверено, что **на старом стенде поведение идентичное** (те же размеры файлов
   5126 / 52522 / 13678 байт) — это свойство кода, а не регрессия переезда.
2. **`entryMode()` всегда возвращала `null`** — читалось свойство `entry.header.attributes`,
   которого у `adm-zip` не существует. Проверено на `adm-zip@0.5.18`:
   `grep -n 'attr' node_modules/adm-zip/zipEntry.js` → геттер называется `attr`
   (строки 332/335), поиск `this.attributes` по всей библиотеке — пусто.
   Замер на реальном архиве: для записи с режимом `100755` функция отдавала `null`,
   при чтении `attr` — `100755`. Следствия: executable-бит молча терялся, а ветка
   symlink'ов в `extractZip` была **мёртвым кодом**.
3. **Самоподписанный сертификат выпускался с подписью SHA-1.** `selfsigned`
   по умолчанию использует `algorithm: 'sha1'` (см. его README и `index.js:105`),
   а панель этот параметр не передавала. Проверено `openssl x509 -text`:
   `Signature Algorithm: sha1WithRSAEncryption`. Симптом со стороны клиента:
   `curl https://127.0.0.1:8443/` → `TLS alert handshake failure`, при этом
   `openssl s_client` соединение устанавливал. Современные браузеры такой сертификат
   не принимают.
4. **HTTPS-сервер обрывал рукопожатие без SNI.** У `https.createServer` был только
   `SNICallback` и не было `key`/`cert`. Если клиент не прислал SNI (запрос по IP),
   `SNICallback` не вызывается вовсе, и сервер отдавал `TLS alert handshake failure`
   (alert 40). Проверено: `curl -k https://127.0.0.1:8443/` без SNI → код `000`,
   `openssl s_client` без `-servername` → `SSL alert number 40`.
5. **`npm audit`.** До правок — 4 high (`adm-zip` ×4 advisory). После обновления
   `adm-zip` до `0.6.1` — 3 high, все от `node-forge` (через `acme-client` и `selfsigned`).
   Advisory `GHSA-86w9-cpqp-85rv` (RSA PKCS#1 v1.5: проверка подписи принимает лишние
   вложенные `DigestAlgorithm`). **Уязвимы все версии** (`npm audit` → `range: "*"`),
   исправленной версии нет; единственное «исправление» — откат `acme-client` до `2.1.0`
   (ломающее). Реальная достижимость в панели не подтверждена: панель использует
   `acme.crypto` (нативный `crypto` Node), а не `acme.forge`
   (`src/ssl/acme.js:30,65,89`); `selfsigned` только **подписывает**, а `verifyCertificateChain`
   в нём лежит внутри ветки `options.clientCertificate`, которую панель не включает.
   Решение: **не трогать** зависимость, зафиксировать как принятый риск.

**Изменения** (все правки — в рабочей копии `D:\Projects\SitePanel`, затем выложены на серверы).

1. **Авторизация на всё приложение админки** — `src/index.js:39`: добавлен
   `app.use(auth.middleware)` до `express.static` и SPA-fallback. Прежняя возможность
   отдать авторизацию внешнему реверс-прокси сохранена через `PANEL_NO_AUTH=1`.
2. **`no-store` на ответе 401** — `src/auth.js:70`: `res.setHeader('Cache-Control', 'no-store')`,
   чтобы отказ не закрепился в кэше и не сломал вход после ввода пароля.
   Из `src/auth.js` экспортирован `hashPassword` — нужен тестам.
3. **`entryMode` читает `attr`** — `src/sites/manager.js:421`:
   `const attr = entry ? entry.attr || (entry.header && entry.header.attr) : null;`
   `entryMode` добавлен в экспорт модуля (строка 955) для тестов.
4. **Подпись SHA-256** — `src/ssl/certs.js:27-32` (константа `SIGN_ALGORITHM = 'sha256'`),
   передана в `ensureDefaultCert` (строка 43) и `issueSelfSigned` (строка 59).
5. **Сертификат по умолчанию для HTTPS без SNI** — `src/ssl/certs.js:163-172`
   (новая функция `defaultCertFiles()`, добавлена в экспорт) и `src/httpserver.js:194`:
   `{ SNICallback: certs.sniCallback, ...certs.defaultCertFiles() }`.
6. **`adm-zip` обновлён** `^0.5.16` → `^0.6.1` — `package.json:16`, `package-lock.json`,
   на серверах `npm install adm-zip@0.6.1`. Совместимость проверена отдельно:
   API `attr` в `0.6.1` сохранён (`zipEntry.js:342/345`), `addLocalFile`, `getEntries`,
   `isDirectory`, `getData` работают как прежде.

**Новые тесты.** `tests/tls.test.js` (3 теста: подпись не SHA-1; рукопожатие без SNI;
сертификат по умолчанию для чужого имени), `tests/extract.test.js` (6 тестов:
чтение режима из `attr`, в том числе с `header`; отсутствие `attributes` даёт `null`;
executable-бит сохраняется; symlink создаётся; symlink за пределы каталога не создаётся),
`tests/auth.test.js` (регрессия на закрытую оболочку админки).

**Проверка.**

- **Мутационная проверка новых тестов** (важно: тест, который не ловит возврат дефекта,
  бесполезен). На сервере временно возвращены оба дефекта:
  удаление `algorithm: SIGN_ALGORITHM` → падает **ровно** тест про SHA-1;
  удаление `...certs.defaultCertFiles()` → падает **ровно** тест про рукопожатие без SNI;
  после восстановления файлов (`diff -q` совпал) — снова `# pass 3`, `# fail 0`.
  Отдельно: первая редакция теста про SHA-1 использовала
  `X509Certificate.signatureAlgorithm` и на Node 22 боевого стенда **молча уходила в skip**
  (`signatureAlgorithm` появился только в Node 18.13+/20+), то есть главная регрессия
  оставалась непроверенной. Тест переписан на поиск ASN.1-OID алгоритма подписи
  (`06 09 2a 86 48 86 f7 0d 01 01 05` / `... 0b`) прямо в DER, что не зависит от версии Node.
- **Полный набор тестов:** на новом стенде — `1..61`, `# pass 61`, `# fail 0`, `# skipped 0`;
  на старом — `1..61`, `# pass 61`, `# fail 0`, `# skipped 0`.
  (На рабочей машине тесты запустить нельзя: `node --test` под песочницей падает с
  `spawn EPERM` — это ограничение среды, а не кода: падает и прежний `tests/unit.test.js`.)
- **Живой эффект правок.** Новый стенд: подпись сертификата по умолчанию до правки —
  `sha1WithRSAEncryption`, после перевыпуска — `sha256WithRSAEncryption`;
  `curl -k` без SNI было `000` (handshake failure), стало `404`.
  Старый стенд: то же самое, `sha1WithRSAEncryption` → `sha256WithRSAEncryption`,
  `curl -k` без SNI → `404`.
- **Админка закрыта** (новый стенд, снаружи): `/` → `401`, `/api/system` → `401`,
  `/app.js` → `401`, `/style.css` → `401`; в ответе `WWW-Authenticate: Basic realm="SitePanel"`,
  `Cache-Control: no-store`. `http://beget.evil-mesh.ru/` → `301` на HTTPS.
- **Старый стенд, размещённые сайты не затронуты:** `p.evil-mesh.ru` → `200`,
  `pqr.evil-mesh.ru` → `200`, `panel.evil-mesh.ru` → `401` (ожидаемо — своя авторизация),
  `m.evil-mesh.ru` → `401` с `WWW-Authenticate: Basic realm="MeshCentral Monitor"` —
  это **собственная** авторизация размещённого MeshCentral, а не панели;
  `rm.evil-mesh.ru` → `000` — так и задумано (заглушка `ssl_reject_handshake`, см. запись ниже).
  `p.evil-mesh.ru` по HTTP → `301`. `journalctl -u sitepanel -p err` и `-u nginx -p err`
  за 30 минут — пусто.
- **Сверка выкладки по контрольным суммам** (md5 совпали на всех трёх сторонах —
  рабочая копия, новый и старый серверы): `certs.js` `b15229eba4a994ac18aeea20012ff2d6`,
  `httpserver.js` `c500c11df5ff91ecf6b11083684d96f7`, `index.js` `a66b8cd2995f6d4a18b9d765e43ac473`,
  `auth.js` `f0d0a964e8dfd0592b96660f76222559`, `manager.js` `cf6c00a2820d6c8ef62be0605a0dae3e`.
  Промежуточный промах: на старый сервер сначала не был скопирован `manager.js` — тесты дали
  `# fail 4` (падали тесты `entryMode` и executable-бита, `expected 493 actual 420`).
  Это подтвердило, что тесты ловят дефект, но показывало неполную выкладку.

**Инфраструктура — новый стенд `141.133.197.43`** (проверено):

- **swap 2 ГБ** создан (`/swapfile`, `chmod 600`, `mkswap`, `swapon`), запись
  `/swapfile none swap sw 0 0` добавлена в `/etc/fstab`; бэкап — **`/root/fstab.bak.20261012-092707`**.
  Дополнительно **`/etc/sysctl.d/99-sitepanel.conf`**: `vm.swappiness=10`,
  `vm.vfs_cache_pressure=50` (проверено `sysctl vm.swappiness` → `10`).
  `free -h` → `Swap: 2.0Gi`.
- **Часовой пояс `Europe/Moscow`** (`timedatectl set-timezone Europe/Moscow`) —
  было `Etc/UTC`. `Local time: Mon 2026-10-12 12:27:07 MSK`, NTP синхронизирован.
- **Заглушка на порту 80** — `/etc/nginx/sites-available/000-http-reject` + симлинк,
  `listen 80 default_server` / `[::]:80 default_server`, `server_name _`, `return 444`;
  симлинк на дефолтный вхост `/etc/nginx/sites-enabled/default` снят.
  Бэкап старого дефолтного вхоста — **`/root/default.nginx.bak.20261012-122730`**.
  Было: запрос по IP (`Host: 141.133.197.43`) → `200` «Welcome to nginx!»;
  стало → соединение закрывается без ответа (код `000`).
  `nginx -t` → `syntax is ok`, `test is successful`; `reload` прошёл;
  `beget.evil-mesh.ru` работает (`301`/`401`).
- **`zip` установлен** (`apt-get install -y zip`, `3.0-13ubuntu0.2`; на старом стенде тоже) —
  без него два теста symlink'ов уходили в `# SKIP нужен POSIX и системный zip`.
  После установки: `# pass 61`, `# skipped 0`.
- **Продление сертификата после замены дефолтного вхоста проверено.** ACME-challenge
  доступен по домену (`curl -H 'Host: beget.evil-mesh.ru' http://127.0.0.1/.well-known/
  acme-challenge/<токен>` → `200` и тело токена), а по IP и по неизвестному имени —
  закрыт (код `000`, заглушка `return 444` работает как задумано).
  `certbot renew --dry-run` → **`Congratulations, all simulated renewals succeeded`**
  для `beget.evil-mesh.ru` (`success`). После прогона вхост не перезаписан
  (`proxy_pass http://127.0.0.1:3100` на месте, 1 вхождение; в
  `/etc/letsencrypt/renewal/beget.evil-mesh.ru.conf` — `authenticator = webroot`,
  `installer = None`), сертификат `VALID: 89 days`, админка отвечает `401` анонимно
  и `200` с паролем.

**Осталось.**

- **`node-forge` (`GHSA-86w9-cpqp-85rv`, high) остаётся.** Исправленной версии нет
  (уязвимы все, `range: "*"`); откат `acme-client` до `2.1.0` — ломающее изменение.
  Достижимость в коде панели не подтверждена (см. «Диагностика», п. 5), но зависимость
  остаётся в дереве — при обновлении `acme-client`/`selfsigned` перепроверить.
- **Порт 80 на старом стенде `46.29.164.250` не менялся.** Его дефолтный вхост
  `/etc/nginx/sites-available/default` содержит не только `default_server`, но и
  **управляемые certbot блоки живого сайта** `www.p.evil-mesh.ru` (строки 93–163:
  `ssl_certificate /etc/letsencrypt/live/p.evil-mesh.ru/...`, `return 404` для HTTP).
  Снятие этого файла сломало бы рабочий домен, поэтому трогать его не стал:
  отдача «Welcome to nginx!» по IP — косметика, а риск реален.
  Если закрывать — сначала перенести блоки `p.evil-mesh.ru` в отдельный файл.
- **Автоматической выкладки из репозитория на серверы по-прежнему нет** — файлы
  копируются вручную (`scp`); расхождение ловится только сверкой контрольных сумм.
- **Смена часового пояса выполнена только на новом стенде.** На старом остаётся `Etc/UTC`;
  менять не стал, чтобы не сдвинуть `Date` в логах размещённых сайтов без согласования.
- **`panel.evil-mesh.ru` и остальные домены** по-прежнему указывают на старый стенд;
  переключения DNS не было.
- **На старом стенде `46.29.164.250` нет `fail2ban`** — проверено: `systemctl is-active
  fail2ban` → `inactive`, `systemctl is-enabled fail2ban` → `not-found`, `dpkg -l fail2ban`
  пуст. Это состояние **до** работ и моими правками не создавалось (в записи ниже речь
  о `fail2ban` на **новом** стенде, где он установлен и активен). Старый стенд защищён
  только `sshd` и UFW; если требуется паритет — поставить `fail2ban` и включить jail `sshd`.
  Отдельно: на старом стенде вход root **по паролю всё ещё разрешён** (усиление доступа
  выполнялось только на новом) — при желании закрывать так же ключом
  + `/etc/ssh/sshd_config.d/01-hardening.conf`.

**Артефакты.** Бэкапы на новом стенде: `/root/certs-default.bak.20261012-085820` (старый
сертификат с SHA-1), `/root/fstab.bak.20261012-092707`, `/root/default.nginx.bak.20261012-122730`.
На старом: `/root/sitepanel-backup-20261012-120814` (полный `src/`, `tests/`, `package*.json`,
каталог сертификатов; 436 КБ) и `/root/certs-default-old.bak.20261012-090857`.
Разовый тестовый каталог `/root/zip-attr-test` на новом стенде — проверка `entryMode`.

---

## 2026-10-12 — Развёрнут новый стенд SitePanel на сервере `141.133.197.43`

**Запрос.** (m00001) Пользователь дал доступ к новому серверу:
`ssh root@141.133.197.43`, пароль в открытом виде. Отдельной задачи в первом сообщении
не было — уточнено вопросом. (m00050) Из трёх вариантов выбран **«Развернуть SitePanel
с нуля»** и **«Усилить доступ»** (SSH-ключ, отключение входа root по паролю, UFW, fail2ban).
Дополнительно: (m00098) публиковать админку **через nginx** с TLS, домен — **новый**
(не переключать DNS со старого стенда); (m00116) домен `beget.evil-mesh.ru`, учётные данные
админки заданы пользователем (пароль в журнале замаскирован).

**Диагностика — состояние до работ.** Сервер пустой: из сети слушает только `22`, UFW
выключен (`iptables` — все политики `ACCEPT`), вход root по паролю разрешён.
Всё ниже — **проверено** командами по SSH.

| Параметр | Значение |
|---|---|
| Хост / ОС | `yblrhcoxcd`, Ubuntu 26.04.1 LTS, ядро `7.0.0-31-generic`, KVM/QEMU, Beget (`beget-agent.service`) |
| IP | `141.133.197.43` (eth0, `/32`) |
| Ресурсы | 2 vCPU, 1962 МБ RAM, **swap 0**, `/dev/vda1` 28 ГБ (занято 2.9 ГБ) |
| Слушало | только `22/tcp` (sshd) + локальные `systemd-resolved` и `chronyd` |
| Отсутствовало | нет nginx, нет node/npm, нет docker, нет `/opt/sitepanel`, нет `/var/www` |
| Часовой пояс | `Etc/UTC` (не МСК) |

Домен `beget.evil-mesh.ru` **уже** указывал на новый IP (`A 141.133.197.43`), NS зоны —
Timeweb (`ns1.timeweb.ru` и др.). На старый стенд `46.29.164.250` по-прежнему смотрят
`panel/pqr/m.evil-mesh.ru` — они не трогались.

**Изменения.**

1. **Доступ по ключу.** Публичная часть выведена из приватного
   `C:\Users\pogpu\.ssh\sitepanel_vps` (`ssh-keygen -y`) и добавлена в
   `/root/.ssh/authorized_keys`. Бэкап: **`/root/.ssh/authorized_keys.bak.20261012-075500`**
   (сохранён исходный ключ `beget-access-key`).
   *Нюанс рабочей машины:* `C:\Users\pogpu\.ssh\known_hosts` **не доступен агенту на запись**
   (`Add-Content` → «Отказано в доступе»), поэтому новые хосты проверены в известных отпечатках
   не сохраняются. `plink` работает только с явным `-hostkey`, `ssh`/`scp` — с
   `-o UserKnownHostsFile=NUL`. Отпечаток нового сервера:
   `ssh-ed25519 SHA256:OzfQIJV31oxe+QKfPBK8PxRGvgZXiYOBoIWy7sVYsjk`.
2. **sshd — вход только по ключу.** Создан **`/etc/ssh/sshd_config.d/01-hardening.conf`**:
   `PermitRootLogin prohibit-password`, `PasswordAuthentication no`,
   `KbdInteractiveAuthentication no`, `PubkeyAuthentication yes`. Бэкап основного конфига:
   **`/root/sshd_config.bak.20261012-075800`**.
   **Важная находка:** sshd берёт **первое** встреченное значение параметра, а не последнее.
   Первая попытка с именем `99-hardening.conf` была молча перекрыта файлом
   `/etc/ssh/sshd_config.d/50-cloud-init.conf` (в нём `PasswordAuthentication yes`), и
   `sshd -T` продолжал показывать `passwordauthentication yes`. Помогло только имя
   `01-…`, которое сортируется перед `50-cloud-init.conf`. Дополнительно создан
   **`/etc/cloud/cloud.cfg.d/99_sitepanel.cfg`** (`ssh_pwauth: false`, `disable_root: false`),
   чтобы cloud-init не вернул парольный вход при своей реконфигурации.
3. **UFW.** `ufw default deny incoming`, `allow outgoing`, правила `22/tcp`, `80/tcp`,
   `443/tcp` (v4 и v6), включён. `fail2ban` уже стоял включённым, jail `sshd` активен.
4. **Пакеты:** `nodejs 22.22.1`, `npm 9.2.0`, `nginx 1.28.3`, `certbot 4.0.0`,
   `ufw 0.36.2` (до этого отсутствовали).
5. **Панель в `/opt/sitepanel`.** Файлы перенесены из рабочей копии
   `D:\Projects\SitePanel` (`package.json`, `package-lock.json`, `LICENSE`, `README.md`,
   `CHANGELOG.md`, `AGENTS.md`, `WORKLOG.md`, `src/`, `tests/`), затем `npm ci --omit=dev`
   → 119 пакетов. Права пересобраны (`chmod -R u=rwX,go=rX src tests`) — `scp` распаковал
   каталоги как `drwx---rwx`.
6. **systemd.** **`/etc/systemd/system/sitepanel.service`** — копия юнита со старого стенда,
   для паритета: `WorkingDirectory=/opt/sitepanel`, `ExecStart=/usr/bin/node src/index.js`,
   `Restart=on-failure`, `RestartSec=5`, `NODE_ENV=production`, `PANEL_HTTP_PORT=8080`,
   `PANEL_HTTPS_PORT=8443`, `PANEL_ADMIN_PORT=3100`. Служба `enable` + `start`.
7. **Учётные данные админки** заменены штатным `POST /api/password` на заданные
   пользователем (пароль — `***`, не в журнале).
8. **nginx-вхост `/etc/nginx/sites-available/beget-admin`** (+ симлинк в `sites-enabled`):
   `listen 80` — ACME-challenge из `/var/www/html` и `301` на HTTPS; `listen 443 ssl` —
   сертификат Let's Encrypt и `proxy_pass http://127.0.0.1:3100` с `X-Forwarded-Proto`.
   Сертификат выпущен `certbot --nginx -d beget.evil-mesh.ru`, затем вхост переписан вручную.
   Бэкапы: **`/root/beget-admin.nginx.bak.20261012-082800`** (certbot-версия),
   **`/root/default.nginx.bak.20261012-082500`** (дефолтный вхост до правок; проверено —
   остался идентичен исходному).
9. **Продление переведено на webroot.** В `/etc/letsencrypt/renewal/beget.evil-mesh.ru.conf`
   `authenticator = nginx` → `webroot` (+ `webroot_path = /var/www/html,`,
   `installer = None`), иначе следующий `certbot renew` перезаписал бы вхост и убрал проксирование.
   Бэкап: **`/root/beget-renewal.conf.bak.20261012-082800`**.
10. **Заглушка для неизвестных SNI — `/etc/nginx/sites-available/000-ssl-reject`**
    (`listen 443 ssl default_server;` + `ssl_reject_handshake on;`).
    *Причина:* без явного `default_server` HTTPS-запрос с произвольным именем попадал в
    первый блок с `listen 443`, то есть в `beget-admin`, и посторонний получал **админку
    панели** с сертификатом `CN=beget.evil-mesh.ru` (проверено: неизвестный SNI → `200`,
    `<title>SitePanel — панель управления сайтами`). То же самое было на старом стенде.

**Проверка.** Всё ниже — **проверено**, кроме отмеченного.

- Тесты панели на новом сервере: `node tests/run.js` → **`# tests 46`, `# pass 46`,
  `# fail 0`** (113 с).
- Снаружи (с рабочей машины, `curl`/`node fetch`): `http://beget.evil-mesh.ru/` → **`301`
  → `https://beget.evil-mesh.ru/`**; `https://…/api/system` без авторизации → **`401`** с
  `WWW-Authenticate: Basic realm="SitePanel"`; с авторизацией → **`200`**,
  `{"nodeVersion":"v22.22.1",…,"adminPort":3100,"dataDir":"/opt/sitepanel/data"}`;
  `https://…/` → **`200`**, 5126 байт, `<title>SitePanel — панель управления сайтами</title>`,
  `Strict-Transport-Security: max-age=31536000`, `Content-Security-Policy` присутствует.
- CSRF: `PUT /api/settings` **без** `X-Requested-With` → **`403`**
  (`Запрос отклонён: отсутствует заголовок X-Requested-With`), **с** заголовком → **`200`**.
- Сквозной тест развёртывания: создан статический сайт из zip → `status: running`;
  привязан домен `smoke.evil-mesh.ru`; запрос через реверс-прокси панели на `8080` с
  `Host: smoke.evil-mesh.ru` → **`200`**, ожидаемый HTML; неизвестный домен → **`404`**;
  сайт удалён, `GET /api/sites` → **`[]`**, каталог `data/sites/` пуст.
- Порты снаружи: `22`, `80`, `443` — открыты; `3100`, `8080`, `8443`, `9000`, `3000` — закрыты.
- Заглушка SNI: неизвестный SNI → TLS-алерт `unrecognized name` (alert 112), `curl` код `000`,
  сертификат не отдаётся; `beget.evil-mesh.ru` при этом работает (`200`).
- `nginx -t` — `syntax is ok`, `test is successful`; `systemctl reload nginx` проходит.
  `certbot certificates` — `beget.evil-mesh.ru`, `ECDSA`, до `2027-01-10` (89 дней).
- `systemctl is-active sitepanel` → `active`, `is-enabled` → `enabled`;
  `journalctl -u sitepanel -p err` → **пусто**.
- `sshd -T` → `permitrootlogin prohibit-password`, `passwordauthentication no`,
  `pubkeyauthentication yes`; вход по паролю извне падает
  (`No supported authentication methods available (server sent: publickey)`), вход по ключу
  работает. `fail2ban` — `active`, `enabled`, 0 банов.

**Осталось.**

- **Статика админки отдаётся без авторизации.** `/`, `/app.js`, `/style.css` →
  `200` **без** `Authorization`; `auth.middleware` навешен только на `/api`
  (`src/index.js:33-36`, `src/admin/routes.js:22`). Проверено, что **на старом стенде
  поведение идентичное** (те же файлы, те же размеры: 5126 / 52522 / 13678 байт), то есть
  это не регрессия переезда, а свойство текущего кода. Утечки данных нет — только сам
  интерфейс, но поверхность лучше закрыть.
- **`npm audit` — 4 high:** `adm-zip` (4 advisory: SUID/SGID из zip, дубли записей,
  обход лимита в `getDataAsync`, DoS в async DEFLATE) и `node-forge` через
  `acme-client` и `selfsigned`. Автоисправление (`npm audit fix --force` → `adm-zip@0.6.1`,
  `acme-client@2.1.0`) — **ломающее**, не применял.
- **Нет swap** при 1962 МБ RAM (доступно ~1.5 ГБ) — как и на старом стенде.
- **Время сервера — UTC**, не `Europe/Moscow` (как и на старом).
- HTTP-запрос **по IP** (`Host: 141.133.197.43`) отдаёт `Welcome to nginx!` из дефолтного
  вхоста — безвредно, но при желании закрывается заглушкой.
- Домены `panel/pqr/m.evil-mesh.ru` по-прежнему на `46.29.164.250`; переключение не делалось
  и не планировалось в этой задаче.
- Обновление панели на сервере выполняется копированием файлов вручную — автоматической
  выкладки из репозитория нет (как и на старом стенде).

**Артефакты.** Скрипты и проверки этой задачи выполнялись через SSH без сохранения на диск
рабочей копии; разовые проверочные файлы (`.tmp-*.mjs`) создавались в корне проекта и удалены
(они под `.gitignore` по маске `.tmp-*`). Публичный ключ, выведенный из приватного, в
репозиторий не сохранялся (`C:\Users\pogpu\.ssh\sitepanel_vps` — приватный ключ вне репозитория).

---

## 2026-10-12 — Приборка сирот удалённого сайта meshclient-mobile, домен `rm.evil-mesh.ru` закрыт

**Запрос.** (m00572) Продолжение задачи по удалённому сайту `75d37d7f86bb`
(meshclient-mobile, домен `rm.evil-mesh.ru`). Пользователь выбрал из трёх вариантов:
«Прибрать сироты и оставить домен закрытым» — то есть удалить следы сайта в nginx и
Let's Encrypt, сам домен не переиспользовать и не отдавать по нему ничего.

**Диагностика.** При подготовке выяснился неочевидный факт, который изменил план работ.
Если бы вхост `/etc/nginx/sites-available/rm` был просто удалён, запросы по домену
провалились бы в **дефолтный сервер 443** — а это первый по порядку блок `default`
(`/etc/nginx/sites-available/default`), который отдаёт `www.p.evil-mesh.ru`:

- проверено: `curl -sk --resolve zzz-ever-not-a-vhost.example:443:127.0.0.1 https://zzz-ever-not-a-vhost.example/`
  → `HTTP/1.1 200 OK`, `<title>Welcome to nginx!</title>`, сертификат `subject: CN=p.evil-mesh.ru`;
- в `nginx -T` явного `default_server` для 443 нет ни в одном блоке (строки 230–231 и
  300–301 в `default` — закомментированы), поэтому дефолтным становится первый
  подключённый блок с `listen 443`, то есть `default`.

То есть наивное удаление вхоста показало бы посетителям `rm.evil-mesh.ru` чужой сайт
`www.p.evil-mesh.ru` с предупреждением о несовпадении сертификата. Поэтому вместо
удаления вхост заменён на минимальный «отказной».

**Изменения.**

1. Полный бэкап всего, что удаляется и переписывается, — **`/root/rm-cleanup-full-20261012-072339.tar.gz`**
   (4841 байт). Содержимое: `etc/nginx/sites-available/rm`, `etc/nginx/.htpasswd-rm`,
   `root/.rm-basic-pass`, `etc/letsencrypt/renewal/rm.evil-mesh.ru.conf` и весь
   `etc/letsencrypt/archive/rm.evil-mesh.ru/` (cert1.pem, chain1.pem, fullchain1.pem,
   privkey1.pem). Путь продублирован в `/root/.rm-cleanup-full-last`.
   Ранее сделанный частичный бэкап `/root/rm-cleanup-bak-20261012-072153.tar.gz` (1407 байт,
   без сертификатов) тоже остался на месте.
2. `/etc/nginx/sites-available/rm` перезаписан минимальным конфигом: сервер на 80 порту
   с `location / { return 404; }` и сервер на 443 с `ssl_reject_handshake on;` — TLS-рукопожатие
   для этого имени отклоняется, сертификат не нужен вовсе. Симлинк
   `/etc/nginx/sites-enabled/rm` сохранён (это и удерживает домен от провала в дефолт).
3. Удалены: `/etc/nginx/.htpasswd-rm`, `/root/.rm-basic-pass`,
   `/etc/letsencrypt/live/rm.evil-mesh.ru`, `/etc/letsencrypt/renewal/rm.evil-mesh.ru.conf`.

**Проверка.**

- `nginx -t` → `syntax is ok`, `test is successful`; `systemctl reload nginx` прошёл.
- `http://rm.evil-mesh.ru/` → **404** (ожидаемо). `https://rm.evil-mesh.ru/` → код `000`,
  рукопожатие отклонено, как и задумано.
- Соседние домены не затронуты: `m.evil-mesh.ru` → 401, `pqr.evil-mesh.ru` → 200,
  `panel.evil-mesh.ru` → 200. Дефолтный блок для неизвестного SNI по-прежнему отдаёт 200
  (то есть поведение остальных имён не изменилось).
- `certbot certificates` → остались ровно 4 сертификата (m, p, panel, pqr), упоминаний
  `rm.evil-mesh.ru` больше нет; поиск по `/etc/letsencrypt/renewal/` и `renewal-hooks/` пуст.
- `grep -rln "rm.evil-mesh.ru" /etc/nginx/` → только сам `sites-available/rm`.
- `certbot renew --dry-run` → **`Congratulations, all simulated renewals succeeded`** для
  четырёх оставшихся сертификатов (m, p, panel, pqr), все `(success)`; удаление
  `renewal/rm.evil-mesh.ru.conf` цикл продления не сломало.
  Побочное наблюдение: повторный запуск `certbot` немедленно после предыдущего падает с
  `Another instance of Certbot is already running.` — первый dry-run держит блокировку
  (внутренняя случайная задержка в логе: `Non-interactive renewal: random delay of 346.2 s`),
  нужно дождаться завершения, иначе результат будет ложным.

**Осталось.** Сам файл `/etc/nginx/sites-available/rm` оставлен намеренно — без него домен
проваливается в чужой `default`. Если домен станет не нужен совсем, удалять вхост нужно
одновременно с добавлением явного `default_server`-заглушки на 443. DNS-запись
`rm.evil-mesh.ru → 46.29.164.250` не трогалась.

---

## 2026-10-12 — Подключено Chrome-расширение DSH; зафиксировано состояние после удаления сайта meshclient-mobile

**Запрос.** (m00398) «Chrome-расширение DSH не подключено - подключи». Затем (m00486)
пользователь сообщил: «Сайт удален из панели».

**Диагностика — почему расширение не подключалось.**

- Серверная половина моста была в порядке: демон `chrome-daemon` слушает `127.0.0.1:37086`
  (процесс 3748), `GET http://127.0.0.1:19387/chrome/status` → `running:true`,
  `extension_connected:false`, `version 0.3.8`, `build be0771e9…`.
  Порт GUI — `19387` (процесс `DeepSeek Harness.exe`, PID 6568), **не** дефолтный `3080`.
- Chrome вообще не был запущен (`Get-Process chrome` → пусто). В профиле
  `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions` каталога
  `kgjjicancjnedmappjhefngdjaommpop` не было — расширение не установлено, и его id не
  упоминается ни в `Preferences`/`Secure Preferences`, ни в `User Data` вообще.
- Установить расширение сам агент не может: `dsh-chrome-control` — только серверная половина,
  в пакете `C:\Users\pogpu\.dsh\profiles\desktop\node_modules\dsh-chrome-control` лежат
  `binaries/<platform>/chrome-daemon*`, `lib/server.js`, `native-host/dsh-native-host.mjs`
  и `skills/chrome`, но **crx/unpacked-сборки расширения там нет**. В `resources/app.asar`
  (115.7 МБ) id расширения тоже не встречается. Native-messaging host `com.dsh.chrome` по
  замыслу регистрируется только на macOS/Linux (`lib/server.js`, комментарий «macOS and Linux
  only; on Windows the registration lives in the registry»), на этой машине его не было
  ни в `HKCU`, ни в `HKLM`.

**Изменения.** Расширение поставлено через штатный механизм внешних расширений Chrome
(external extension), без прав администратора, пользователем `EVIL-PC\pogpu`:

- создан раздел реестра
  `HKCU\Software\Google\Chrome\Extensions\kgjjicancjnedmappjhefngdjaommpop`
  со значением `update_url = https://clients2.google.com/service/update2/crx`;
- Chrome перезапущен (до правки он был не запущен, вкладок пользователя не потеряно).

**Проверка.** После перезапуска Chrome: каталог
`…\User Data\Default\Extensions\kgjjicancjnedmappjhefngdjaommpop\0.3.8_0` появился,
`/chrome/status` → **`extension_connected:true`**, `extension_version 0.3.8`;
`mcp__chrome__list_tabs` отвечает успешно, `navigate` открывает страницы.
Оговорка: скриншоты через `screenshot` недоступны — текущая модель не принимает
изображения на вход; страница проверялась через `evaluate`/`get_text`.

**Важная находка при проверке в браузере — сервис-воркер пережил удаление сайта.**
Открытие `https://rm.evil-mesh.ru/` в реальном Chrome **сначала показало работающее
приложение** с 28 онлайн-устройствами и полным списком (31 строка), хотя на сервере
процесса уже не было: страница отдавалась из Cache Storage `meshclient-v5` (12 записей:
`/`, `/index.html`, `/app.js`, `/style.css`, `/i18n.js`, `/vendor/xterm.js`,
`/vendor/xterm.css`, `/vendor/fit.js`, `/manifest.webmanifest`, `/icons/icon-192.png`,
`/icons/icon-512.png`, `/icons/icon-maskable-512.png`) через зарегистрированный
`https://rm.evil-mesh.ru/sw.js`. Это доказывает: **`curl` мог показывать 404, а браузер
пользователя — старое приложение**, и наоборот. Свежий запрос из того же окна
(`fetch('/api/status', {cache:'reload'})`) давал уже 404 с HTML «Домен не настроен».
Кэш и регистрация SW удалены через `caches.delete` / `unregister` — после перезагрузки
страница честно отдаёт 404.

**Состояние после удаления сайта** (сообщение пользователя m00486; серверное время
11 октября 23:14 — 12 октября 07:16 UTC, то есть ориентировочно 10:14–10:16 МСК).
Удалён сайт `75d37d7f86bb` **meshclient-mobile** (домен `rm.evil-mesh.ru`).

- В `/opt/sitepanel/data/db.json` остались **2** сайта: `238b5bbfec01` (pqr) и
  `3ebc4e88346e` (mesh-monitor). Порт `10002` больше никто не слушает.
- Удалены: каталог `/opt/sitepanel/data/sites/75d37d7f86bb`, его `.backup`,
  `/opt/sitepanel/data/logs/75d37d7f86bb.log` и `/opt/sitepanel/data/certs/75d37d7f86bb`
  (панель чистит всё это в `_removeSite`, `src/sites/manager.js:869-878`, и
  `certs.removeCertFiles`, `src/ssl/certs.js:88`). Поиск по серверу подтвердил: копий
  каталога сайта нет, в `/root/sitepanel-backups/*.tar.gz` лежат только `src` панели.
- `https://rm.evil-mesh.ru/` → **404** (вхост `rm` проксирует на `127.0.0.1:8080`, домен
  больше ни за одним сайтом не закреплён). Остальные домены не затронуты:
  `m.evil-mesh.ru` 401, `pqr.evil-mesh.ru` 200, `panel.evil-mesh.ru` 200.
- **Сироты после удаления** (панель их не убирает — она не управляет `sites-available`):
  `/etc/nginx/sites-available/rm` и симлинк `sites-enabled/rm`; сертификат
  `/etc/letsencrypt/live/rm.evil-mesh.ru` и `/etc/letsencrypt/renewal/rm.evil-mesh.ru.conf`;
  `/etc/nginx/.htpasswd-rm`; `/root/.rm-basic-pass`; бэкап `/root/rm.nginx.bak.20261012-065609`.
- Репозиторий `pogpure3/MeshClient` стал **приватным** (GitHub API без авторизации → 404,
  с токеном → 200 `private=true`). Хранящийся в `db.json` git-токен сайта `3ebc4e88346e`
  доступ к нему имеет, то есть пере-деплой из панели технически возможен.
- Ветка `mobile` ушла вперёд относительно локальной копии: `origin/mobile` = `9b91c1c`
  («Читать PORT/HOST из окружения, запускать web без подкоманды», автор pogpu,
  2026-10-12 01:55 +0300), локально `D:\Projects\Mesh_Client` — `ea892c7`.
- Убран мусорный файл `/root/%{http_code}n`, созданный ранее ошибочной командой.

**Осталось.** Решение пользователя о судьбе сайта `rm.evil-mesh.ru`: пересоздавать его в
панели (тогда — с учётом приватности репозитория и ветки `mobile` = `9b91c1c`) или оставить
удалённым и прибрать сироты (вхост `rm`, сертификат, `.htpasswd-rm`, `/root/.rm-basic-pass`).
До решения ничего из перечисленного не трогал.

---

## 2026-10-12 — Диагностика стенда и починка входа на `rm.evil-mesh.ru`

**Запрос.** Посмотреть, что запущено на сервере, проверить на ошибки и выяснить, почему
сайт `meshclient mobile` запрашивает логин и пароль вместо того, чтобы открывать страницу
авторизации MeshCentral. Отдельно (после отчёта) — по требованию пользователя: всегда
вести историю работ и историю изменений проекта (сообщение m00217), во исполнение чего
созданы `WORKLOG.md` и `AGENTS.md`.

**Стенд на момент диагностики.** Сервер `46.29.164.250`, хост `r1114848` (SSH-алиас
`sitepanel`). Ниже — состояние до правок.

| Что | Где | Порт | Состояние |
|---|---|---|---|
| `sitepanel.service` (`node src/index.js`) | `/opt/sitepanel` | 8080 HTTP-прокси, 8443 HTTPS SNI, 3100 админка | работает, `NRestarts=0` |
| сайт `75d37d7f86bb` **meshclient-mobile** | `/opt/sitepanel/data/sites/75d37d7f86bb`, ветка `mobile` | `127.0.0.1:10002` | running, health 200 |
| сайт `3ebc4e88346e` **mesh-monitor** | `/opt/sitepanel/data/sites/3ebc4e88346e`, ветка `main`, `gitSubdir: monitor` | `127.0.0.1:10000` | running, health 401 (своя Basic-авторизация) |
| сайт `238b5bbfec01` **pqr** | `/opt/sitepanel/data/sites/238b5bbfec01` | `127.0.0.1:10001` | running, health 200 |
| pm2 `pqr` — **дубликат** | `/var/www/pqr` | `0.0.0.0:3000` | online, uptime 17 дней |
| nginx 1.24.0 | — | 80, 443 | конфиг валиден |
| nginx-ui 2.3.8 | `/usr/local/bin/nginx-ui` | было `0.0.0.0:9000` | наружу открыт |

Домены: `rm.evil-mesh.ru` → сайт `75d37d7f86bb`; `m.evil-mesh.ru` → `3ebc4e88346e`;
`pqr.evil-mesh.ru` → панель (`X-Sitepanel-Site: 238b5bbfec01`); `panel.evil-mesh.ru` → админка 3100.
Внешний MeshCentral — `r.evil-mesh.ru` (`5.35.84.174`), отвечает 200, монитор подключён (27 устройств).

**Диагностика — причина запроса логина.**

- В `/etc/nginx/sites-available/rm` (симлинк в `sites-enabled/`, создан 11.10 23:21) в блоке
  `listen 443 ssl; server_name rm.evil-mesh.ru;` на строках **34–35** стояло:
  ```nginx
  auth_basic "MeshClient";
  auth_basic_user_file /etc/nginx/.htpasswd-rm;
  ```
  Проверено: `curl -sk --resolve rm.evil-mesh.ru:443:127.0.0.1 https://rm.evil-mesh.ru/` →
  `HTTP/1.1 401 Unauthorized` + `WWW-Authenticate: Basic realm="MeshClient"`.
  Браузер на такой ответ показывает **свой нативный диалог логина/пароля**, поэтому до
  страницы авторизации MeshCentral запрос не доходил.
- Ввод пароля не помогал: в `/etc/nginx/error.log` запись
  `user "pogpure3" was not found in "/etc/nginx/.htpasswd-rm"` (клиент 2.26.68.56, 05:14),
  а в самом `/etc/nginx/.htpasswd-rm` есть единственный пользователь `mesh`
  (проверка кандидата `mesh:qwerty` → `password mismatch`).
- Само приложение входа по паролю не требует и работает штатно: `curl http://127.0.0.1:10002/`
  → **200**, в HTML есть `<div id="loginOverlay" …>` и `<form id="loginForm">`; через панель
  (`Host: rm.evil-mesh.ru` + `X-Forwarded-Proto: https`) — тоже 200 с `X-Sitepanel-Site: 75d37d7f86bb`.
  Логином закрыт только `/api/*`: `/api/status` → `{"connected":false,"needsLogin":true,...}`.
  В логе сайта — `Web UI: http://127.0.0.1:10002 (вход через страницу авторизации)`.
  Панель не подставляет `MC_URL`/`MC_USER`/`MC_PASS` в окружение процесса: вход задуман через форму.
- Вывод: причина — **лишний слой HTTP Basic auth в nginx**, а не поведение приложения.
  Он же описан в комментарии самого файла: «Шлюз не имеет собственной авторизации: страница /
  отдаётся любому, логин гейтит только /api/*. Поэтому доступ закрыт Basic auth на nginx».

**Изменения.** Оба изменения применены с согласия пользователя.

1. **`/etc/nginx/sites-available/rm`** — удалены строки 34–35 (`auth_basic` и
   `auth_basic_user_file`) из блока `listen 443 ssl`.
   Бэкап: **`/root/rm.nginx.bak.20261012-065609`** (1911 байт, исходный mtime 11.10 23:21).
   Диф подтверждён: `34,35d33`. Затем `nginx -t` — успешно, `systemctl reload nginx`.
   Файл `/etc/nginx/.htpasswd-rm` оставлен на месте (не используется, права `0640 root:www-data`).
2. **`/usr/local/etc/nginx-ui/app.ini`** — в секции `[server]` `Host = 0.0.0.0` → `Host = 127.0.0.1`,
   сервис перезапущен. Бэкап: **`/usr/local/etc/nginx-ui/app.ini.bak.20261012-065651`**.
   Из UFW удалены правила `9000/tcp` (Anywhere, было №4) и `9000/tcp (v6)` (было №8);
   остались только 80, 443, 22.

**Проверка.**

- `https://rm.evil-mesh.ru/` → **200**, 27 714 байт, `X-Sitepanel-Site: 75d37d7f86bb`;
  в разметке `id="loginOverlay"` (1) и `id="loginForm"` (1), текст «Вход на сервер управления»;
  заголовка `WWW-Authenticate` в ответе больше нет. Проверено и снаружи (с рабочей станции), и локально.
- Ассеты: `/app.js`, `/style.css`, `/i18n.js`, `/manifest.webmanifest`, `/sw.js`,
  `/vendor/xterm.js`, `/vendor/xterm.css`, `/vendor/fit.js`, `/icons/icon-192.png` — все **200**.
- `/api/status` → `{"connected":false,"needsLogin":true,"serverInfo":null,"domain":null,"port":10002,"host":"127.0.0.1"}` —
  логин по-прежнему гейтится приложением.
- WS `/ws/terminal` через панель → `HTTP/1.1 101 Switching Protocols`.
- Порт 80 → `301 https://rm.evil-mesh.ru/`; ACME-путь `/.well-known/acme-challenge/…` → 404 (проксируется, токена нет — ожидаемо).
- Остальные домены не затронуты: `m.evil-mesh.ru` 401, `pqr.evil-mesh.ru` 200, `panel.evil-mesh.ru` 200.
- nginx-ui: `ss` показывает `127.0.0.1:9000`, локально отвечает 200;
  снаружи `Test-NetConnection 46.29.164.250 -Port 9000` → `TcpTestSucceeded=False`.
- `nginx -t` после правки — `syntax is ok`, `test is successful`.

**Важная деталь проверки.** Первый прогон проверки сразу после `systemctl reload nginx`
ещё отдавал `401` — отвечал предыдущий (in-flight) worker; повторный прогон через ~25 с дал
`200`. При проверке правок nginx результат нужно перепроверять после того, как старые
worker-процессы завершатся, иначе легко принять успешную правку за неудачную.

**Осталось незакрытым (не трогал — правки не согласованы).**

- **Секреты в открытом виде.** `/opt/sitepanel/data/sites/3ebc4e88346e/config.json` и его
  копия в `3ebc4e88346e.backup/`: пароль MeshCentral, Telegram bot token, пароль страницы
  монитора. В `/opt/sitepanel/data/db.json` — Telegram token и chatId. Стоит вынести в
  переменные окружения, а `.backup`-каталог убрать.
- **Дубликат pqr.** `/var/www/pqr` под pm2 слушает `0.0.0.0:3000`, и именно на него смотрит
  nginx-вхост `pqr.evil-mesh.ru` → `localhost:3000`; панельный сайт `238b5bbfec01` слушает
  `127.0.0.1:10001`. Код один и тот же (совпадает md5 `routes/data.js`, HTML идентичен).
  Один из двух экземпляров лишний; порт 3000 торчит на всех интерфейсах.
- **Порты панели** 8080, 3100, 8443 слушают `0.0.0.0`/`*` вместо loopback.
  Снаружи закрыты UFW (проверено: недоступны), но полагаться только на firewall не стоит.
- **Двойное управление сертификатом `rm.evil-mesh.ru`**: домен обслуживает и certbot
  (`/etc/letsencrypt/renewal/rm.evil-mesh.ru.conf`, `certbot renew --dry-run` успешен), и
  ssl-модуль панели (в логе сайта — одна неудачная попытка выпуска с `404` и одна успешная).
- **Telegram монитора упирается в лимит**: `[telegram] send failed: Too Many Requests: retry after 38`.
- **Мусор в логах**: 404 по `favicon.ico` для `static.46.29.164.250.sslip.io`;
  осиротевший `/opt/sitepanel/data/logs/49c0f8beb458.log` (неудачный `git clone … 403`
  сайта, которого уже нет в `db.json`).
- **Нет swap** при 1.9 ГБ RAM (доступно ~1.2 ГБ). OOM-событий в журнале не найдено.
- **Старый лог pm2 pqr**: `Error: Query read timeout` и PG `42P01` в
  `/root/.pm2/logs/pqr-error.log` — записи не пополняются с 30 сентября, на момент проверки
  неактуальны (проверено: публичный `pqr.evil-mesh.ru` → 200, все три инстанса отдают
  идентичный HTML).

**Чего не делал.** Проверку в реальном браузере выполнить не удалось — расширение Chrome Bridge
в сессии не подключено, поэтому визуальное подтверждение ограничено разбором отдаваемого HTML
и кодами ответов `curl`. Секреты на диске сервера не ротировал.

**Артефакты.** Скрипты диагностики и правок — каталог `.vps/` в рабочей копии
(`fix-rm-auth.sh`, `fix-nginx-ui.sh`, `verify-rm.sh`, `final-verify.sh`, `evidence.sh`
и диагностические `check1.sh`…`check17.sh`). Временные файлы из `/tmp` на сервере удалены.
Локальная рабочая копия проекта панели — `D:\Projects\SitePanel`, репозиторий размещённого
сайта — `D:\Projects\Mesh_Client` (ветка `mobile`, коммит `ea892c7`).

---

## 2026-10-12 — Введены журналы работ и изменений

**Запрос.** Пользователь потребовал всегда вести историю работы и историю изменений проекта
(сообщение m00217).

**Изменения.**

- Создан `WORKLOG.md` (этот файл) — журнал работ: запрос, диагностика, изменения, проверка,
  незакрытые проблемы. Записи — сверху, даты по Europe/Moscow.
- Создан `AGENTS.md` — правила: формат записи, полные пути и точные значения, запрет на
  секреты в журнале, порядок правок конфигов на сервере (бэкап → правка → `nginx -t` → `reload`
  → запись в журнал), обязательное согласие пользователя на правки, затрагивающие безопасность.
- `CHANGELOG.md`: в `[Unreleased]` добавлены секции «Документация» (новые журналы) и
  «Инфраструктура стенда» (правки `rm`-вхоста и nginx-ui от 2026-10-12, перенесены из прошлой
  записи, чтобы изменения не потерялись до релиза).
- `README.md`: в раздел «Журнал изменений» добавлены ссылки на `WORKLOG.md` и `AGENTS.md`
  и указание, что ведение журналов обязательно для любой меняющей задачи.
- `.gitignore`: добавлен каталог `.vps/` — в нём лежат локальные скрипты диагностики и
  правок стенда (адреса сервера, пути к файлам с паролями, `check13.sh` содержит список
  кандидатов паролей). Проверено, что в каталоге нет дампов с секретами (`db.json`,
  `auth.json`, `config.json` там отсутствуют; токенов `AAGQ…`/`ghp_…` в файлах нет).
  `git check-ignore -v .vps/check1.sh` → `.gitignore:24:.vps/`.
- В парном репозитории `D:\Projects\Mesh_Client` созданы свои `AGENTS.md` и `WORKLOG.md`,
  а в его `README.md` исправлен опасный совет «поставьте nginx с Basic-auth» (именно он
  привёл к исходной проблеме) и добавлен раздел со ссылками на журналы.

**Проверка.** Файлы созданы, структура заголовков проверена (`## ГГГГ-ММ-ДД — …`),
переводы строк приведены к LF, `git status` показывает новые файлы как untracked
(`AGENTS.md`, `WORKLOG.md`) и правки `README.md` / `CHANGELOG.md` / `.gitignore`.
Коммит не делал — изменения оставлены в рабочей копии. `node tests/run.js` после правок —
`46` тестов, `46` pass, `0` fail.

**Осталось.** Закоммитить журналы вместе со ссылками из README (по решению пользователя);
в `Mesh_Client` завести `CHANGELOG.md` при первом изменении кода.
