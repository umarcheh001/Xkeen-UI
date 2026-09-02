# Ручная настройка защищённого DNS Mihomo на Keenetic

Пошаговая инструкция для пользователей, которые не могут установить Xkeen UI,
но уже имеют на роутере Entware, XKeen и ядро Mihomo.

Документ повторяет логику кнопки **«DNS» → «Защищённый DNS Mihomo»**. Кнопка
имеет два режима обработки имён:

1. **`redir-host`** — рекомендуемый режим, возвращает реальные IP-адреса.
2. **`fake-ip`** — расширенный режим, возвращает виртуальные IP и требует
   работающего TUN/TProxy.

Скриншот из запроса использован только как иллюстрация окна. Это не набор
команд. Примеры из сторонних инструкций, где Mihomo слушает `1054`, а DNS
роутера вручную направляется на `192.168.1.1:1054`, **не относятся к этой
кнопке** и ниже не применяются.

---

## 1. Что получится

```text
Устройство LAN → DNS роутера:53
                  ↓
           Keenetic dns-override
                  ↓
           Mihomo DNS:0.0.0.0:53
                  ↓
       DoH 8.8.8.8 / 1.1.1.1
       через выбранную proxy-группу
```

DHCP и DNS-адреса клиентов менять не нужно: устройства продолжают использовать
адрес роутера. Защищается участок от Mihomo до публичного DoH-резолвера.

`default-nameserver` и `proxy-server-nameserver` используются как bootstrap для
служебных имён (например, адресов узлов). Основные запросы клиентов идут через
DoH. Если выбранная proxy-группа фактически переключена на `DIRECT`, DoH также
может выйти напрямую — выбирайте группу, в которой есть рабочий прокси.

## 2. Требования и предупреждения

- Команды выполняются по SSH под `root` на роутере Keenetic.
- Должно быть активно ядро **Mihomo**, а не Xray:

  ```sh
  pidof mihomo
  pidof xray
  xkeen -status
  ```

  Если работает Xray, сначала переключите XKeen на Mihomo штатной командой
  вашей версии (обычно `xkeen -mihomo`), затем выполните `xkeen -restart`.
- Не включайте одновременно эту схему и DNS-over-VLESS Xray: обе используют
  порт 53 и переключатель Keenetic `opkg dns-override`.
- В активном YAML должен быть **один** top-level раздел `dns:`. Два раздела
  приведут к ошибке или к тому, что Mihomo прочитает не тот блок.
- Ручная настройка не имеет транзакционного автоотката панели. Перед началом
  обязательно сохраните копию конфигурации и отдельно запишите исходное
  состояние `dns-override`.

## 3. Подготовка и резервная копия

Стандартный путь активной конфигурации:

```sh
CONFIG=/opt/etc/mihomo/config.yaml
test -f "$CONFIG" || { echo "Не найден $CONFIG"; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="${CONFIG}.before-mihomo-dns-${STAMP}"
cp -L "$CONFIG" "$BACKUP" || exit 1
echo "Резервная копия: $BACKUP"
```

Если `config.yaml` является символической ссылкой на профиль, редактирование
`/opt/etc/mihomo/config.yaml` всё равно изменяет активный профиль. Проверить
цель можно так:

```sh
readlink -f "$CONFIG" 2>/dev/null || ls -l "$CONFIG"
```

Запишите состояние переключателя Keenetic **до** изменений:

```sh
ndmc -c "show running-config" | grep -i dns-override
```

- `opkg dns-override` — переключатель был включён;
- `no opkg dns-override` или отсутствие строки — был выключен.

## 4. Выберите существующую proxy-группу

В конфигурации найдите секцию `proxy-groups:` и точное имя группы (регистр,
пробелы и кириллица важны):

```sh
grep -nE '^[[:space:]]*-[[:space:]]*(\{[[:space:]]*)?name[[:space:]]*:' "$CONFIG"
```

В качестве группы для DoH используйте уже существующую группу с прокси,
например `PROXY`, `Заблок. сервисы`, `GLOBAL` или `Auto`. Не выбирайте
`DIRECT`, `REJECT`, `PASS` или группу, в которой сейчас выбран прямой выход.

В примерах ниже вместо `<ИМЯ_ГРУППЫ>` подставьте это имя. Строки URL должны
остаться в одинарных кавычках.

## 5. Вариант 1 — `redir-host` (рекомендуется)

### 5.1. Вставьте DNS-блок

Откройте активный файл:

```sh
vi "$CONFIG"       # либо используйте nano/другой редактор
```

Если top-level `dns:` отсутствует, добавьте следующий блок рядом с верхними
настройками (`profile`, `tun`, `proxies` и т. п.). Порядок top-level секций для
Mihomo не важен:

```yaml
# BEGIN XKeen UI Mihomo DNS (managed) — ручная копия
dns:
  enable: true
  listen: 0.0.0.0:53
  ipv6: false
  enhanced-mode: redir-host
  cache-algorithm: arc
  prefer-h3: false
  use-hosts: true
  use-system-hosts: true
  default-nameserver:
    - 77.88.8.8
    - 1.1.1.1
  proxy-server-nameserver:
    - 77.88.8.8
    - 1.1.1.1
  nameserver:
    - 'https://8.8.8.8/dns-query#<ИМЯ_ГРУППЫ>&name-cert-verify=dns.google'
    - 'https://1.1.1.1/dns-query#<ИМЯ_ГРУППЫ>&name-cert-verify=cloudflare-dns.com'
# END XKeen UI Mihomo DNS (managed) — ручная копия
```

Замените `<ИМЯ_ГРУППЫ>` **в обеих строках**. Например:

```yaml
- 'https://8.8.8.8/dns-query#Заблок. сервисы&name-cert-verify=dns.google'
```

### 5.2. Если в конфиге уже есть `dns:`

Не добавляйте второй раздел. Сохраните резервную копию, затем объедините
настройки вручную в существующем `dns:`. Не удаляйте пользовательские
`nameserver-policy`, `fallback`, `fake-ip-filter` и другие нужные поля без
понимания их назначения. Минимально должны быть согласованы:

```yaml
dns:
  enable: true
  listen: 0.0.0.0:53
  enhanced-mode: redir-host
  nameserver:
    - 'https://8.8.8.8/dns-query#<ИМЯ_ГРУППЫ>&name-cert-verify=dns.google'
    - 'https://1.1.1.1/dns-query#<ИМЯ_ГРУППЫ>&name-cert-verify=cloudflare-dns.com'
```

### 5.3. Обработка `profile.store-fake-ip`

В режиме `redir-host` удалите только строку `store-fake-ip` из секции
`profile`, если она есть. `store-selected` и остальные параметры не меняйте:

```yaml
profile:
  store-selected: true
  # store-fake-ip: true  ← удалить только эту строку для redir-host
```

Сохранённая в разделе 3 копия содержит исходное значение и нужна для возврата.

## 6. Вариант 2 — `fake-ip` (расширенный)

Используйте этот режим только если в текущем конфиге уже есть прозрачная
маршрутизация: `tun.enable: true` **или** ненулевой top-level `tproxy-port`.
Проверка:

```sh
grep -nE '^(tun:|tproxy-port:[[:space:]]*[1-9][0-9]*)' "$CONFIG"
# Если найден tun:, убедитесь, что enable: true находится именно внутри него:
sed -n '/^tun:/,/^[^[:space:]]/p' "$CONFIG"
```

Fake-IP требует, чтобы виртуальные адреса перехватывались TUN/TProxy. Без этого
DNS может отвечать, но соединения по возвращённым виртуальным IP не заработают.

В существующий единственный раздел `dns:` добавьте/измените поля:

```yaml
dns:
  enable: true
  listen: 0.0.0.0:53
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter-mode: blacklist
  fake-ip-filter:
    - '*.lan'
    - '*.local'
  cache-algorithm: arc
  prefer-h3: false
  use-hosts: true
  use-system-hosts: true
  default-nameserver:
    - 77.88.8.8
    - 1.1.1.1
  proxy-server-nameserver:
    - 77.88.8.8
    - 1.1.1.1
  nameserver:
    - 'https://8.8.8.8/dns-query#<ИМЯ_ГРУППЫ>&name-cert-verify=dns.google'
    - 'https://1.1.1.1/dns-query#<ИМЯ_ГРУППЫ>&name-cert-verify=cloudflare-dns.com'
```

### 6.1. Диапазон Fake-IP

`198.18.0.1/16` — значение по умолчанию. Оно не должно пересекаться с LAN,
VPN и другими реальными сетями. Не используйте диапазоны `10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, loopback или link-local. Если ваша сеть
нестандартная, выберите другой свободный IPv4-диапазон с префиксом от `/8` до
`/24`.

### 6.2. Режимы фильтра

- **`blacklist`** — Fake-IP выдаётся всем доменам, кроме перечисленных. Для
  домашней сети обычно оставляют `*.lan` и `*.local`.
- **`whitelist`** — Fake-IP выдаётся только доменам из списка; остальные
  получают реальные адреса.
- **`rule`** — каждая строка является правилом Mihomo и должна заканчиваться
  действием `fake-ip` или `real-ip`, например:

  ```yaml
  fake-ip-filter-mode: rule
  fake-ip-filter:
    - 'RULE-SET,geosite-private,real-ip'
    - 'MATCH,fake-ip'
  ```

Не смешивайте обычные `*.lan` с режимом `rule`.

### 6.3. Необязательный GeoSite

Фильтры `geosite:private` и `geosite:category-ru` работают только при наличии
подходящей GeoSite-базы. Если её нет, оставьте `*.lan`/`*.local` или добавьте в
верхний уровень конфигурации (не внутрь `dns:`):

```yaml
geodata-mode: true
geox-url:
  geosite: 'https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat'
```

После перезапуска Mihomo проверьте журнал загрузки DAT. Наличие пакета
`xk-geodat` само по себе не гарантирует, что Mihomo использует его для
`geosite:private`. Уже существующие `geodata-mode` и `geox-url` не заменяйте
вслепую.

## 7. Проверка YAML до переключения DNS

Сначала проверьте конфигурацию. На штатной установке бинарник находится в
`/opt/sbin/mihomo`:

```sh
MIHOMO_BIN=$(command -v mihomo 2>/dev/null || true)
[ -n "$MIHOMO_BIN" ] || MIHOMO_BIN=/opt/sbin/mihomo
"$MIHOMO_BIN" -t -d /opt/etc/mihomo -f "$CONFIG"
```

Продолжайте только если команда завершилась с кодом `0` и сообщением вроде
`configuration test successful`. При ошибке восстановите `$BACKUP`, исправьте
YAML и повторите проверку. Не включайте `dns-override` с непроверенным файлом.

## 8. Включение `dns-override` и перезапуск

После успешного preflight выполните именно в таком порядке:

```sh
# Освободить порт 53 от системного DNS Keenetic
ndmc -c "opkg dns-override" || exit 1
ndmc -c "system configuration save" || exit 1
ndmc -c "show running-config" | grep -i dns-override

# Перезапустить XKeen/Mihomo
xkeen -restart
```

Если в вашей версии нет команды `xkeen`, используйте найденный init-скрипт:

```sh
/opt/etc/init.d/S05xkeen restart 2>/dev/null || \
/opt/etc/init.d/S99xkeen restart
```

Подождите 10–15 секунд и проверьте:

```sh
pidof mihomo
netstat -lnptu 2>/dev/null | grep ':53' || ss -lnptu 2>/dev/null | grep ':53'
```

На порту 53 должен слушать Mihomo. Если системный DNS не освободил порт или
Mihomo не запустился, немедленно выполните аварийный откат из раздела 10.

## 9. Проверка работы с клиента LAN

На компьютере/телефоне, который получает DNS от роутера, выполните:

```sh
nslookup example.com <IP-АДРЕС-РОУТЕРА>
```

В режиме `redir-host` ответ содержит обычные реальные IP. В режиме `fake-ip`
ответ для большинства доменов должен попасть в диапазон `198.18.0.0/16` (если
вы не задали другой диапазон), а локальные домены из фильтра должны получать
реальные адреса. Откройте несколько сайтов и проверьте локальные устройства.

Если клиент вручную настроен на внешний DNS (например, `8.8.8.8`), он обходит
DNS роутера и эту схему не проверяет.

## 10. Отключение и возврат к исходной конфигурации

Используйте файл `$BACKUP`, созданный в разделе 3. Перед восстановлением можно
сохранить текущий (управляемый) файл для разбора:

```sh
cp -L "$CONFIG" "${CONFIG}.managed-$(date +%Y%m%d-%H%M%S)" || exit 1
cp -L "$BACKUP" "$CONFIG" || exit 1
```

Проверьте восстановленный YAML и перезапустите XKeen:

```sh
"$MIHOMO_BIN" -t -d /opt/etc/mihomo -f "$CONFIG" || exit 1
xkeen -restart
```

После возврата исходного файла восстановите **исходное** состояние переключателя,
которое вы записали в разделе 3:

```sh
# Если до включения dns-override был выключен:
ndmc -c "no opkg dns-override"
ndmc -c "system configuration save"
```

Если до включения уже была строка `opkg dns-override`, не выключайте её без
необходимости: оставьте переключатель включённым и убедитесь, что восстановленный
конфиг действительно содержит нужный DNS-слушатель. После этого снова выполните
`xkeen -restart` и проверьте, что порт 53 обслуживается ожидаемым процессом.

## 11. Аварийный откат, если Mihomo не стартует

Если после включения пропал DNS во всей сети:

```sh
CONFIG=/opt/etc/mihomo/config.yaml
BACKUP=/путь/к/копии/config.yaml.before-mihomo-dns-ГГГГММДД-ЧЧММСС

cp -L "$BACKUP" "$CONFIG" || exit 1
ndmc -c "no opkg dns-override"
ndmc -c "system configuration save"
xkeen -restart
```

Проверьте `pidof mihomo`, наличие ответа `nslookup` и строку
`dns-override` в `ndmc -c "show running-config"`. Если резервная копия повреждена
или её нет, не пытайтесь угадывать YAML: верните рабочий backup профиля Mihomo
из `/opt/etc/mihomo/backup/` и только затем отключайте `dns-override`.

## 12. Что делает кнопка автоматически (для сравнения)

При включении панель выполняет следующие проверки и действия:

1. убеждается, что активно Mihomo, есть proxy-группа и нет второго
   пользовательского `dns:`;
2. для `fake-ip` проверяет TUN/TProxy, диапазон и пересечения сетей;
3. запускает `mihomo -t` на временном YAML;
4. сохраняет полный снимок исходного файла и создаёт обычный backup;
5. записывает новый `config.yaml`, включает `opkg dns-override`, перезапускает
   XKeen и делает UDP-запрос `example.com`;
6. при любой ошибке возвращает YAML, состояние `dns-override` и перезапускает
   сервис.

При ручной настройке эти пункты нужно выполнить самостоятельно; особенно важны
резервная копия, preflight и проверка DNS с клиента. Фоновый сторож панели может
перезапустить ядро или вернуть DNS прошивке после нескольких неудач, но без
панели рассчитывать на автоматический откат нельзя.

## 13. Частые проблемы

| Симптом | Причина и решение |
| --- | --- |
| `dns` уже есть | Не создавайте второй раздел; объедините поля в существующем блоке. |
| Порт 53 занят | Выполните `ndmc -c "opkg dns-override"`, подождите несколько секунд и перезапустите Mihomo. |
| `mihomo -t` сообщает об ошибке | Исправьте отступы YAML, имя proxy-группы и URL DoH; до успешного теста не включайте override. |
| Fake-IP не работает | Проверьте `tun.enable: true` или `tproxy-port`, диапазон и фильтры. |
| Локальные имена не разрешаются | Добавьте `*.lan`, `*.local` (или корректный доменный provider) в fake-IP-фильтр. |
| DoH идёт напрямую | В выбранной группе выбран `DIRECT`; переключите группу на рабочий прокси. |
| После переключения ядра DNS снят | Xray и Mihomo не могут одновременно владеть портом 53; верните нужное ядро и повторите настройку. |

---

Связанные файлы реализации в репозитории: `xkeen-ui/services/mihomo_dns.py`,
`xkeen-ui/routes/mihomo.py` и `xkeen-ui/static/js/features/mihomo_dns.js`.
