Декриптор ссылок Happ
=====================

Ссылки подписок вида `happ://crypt…` (crypt, crypt2, crypt3, crypt4, crypt5)
панель расшифровывает локально, движком `happ-decrypt-universal`. Это один
статический файл на Go: на роутере `crypt5` занимает доли секунды, Node не нужен.

Как поставить
-------------

Проще всего — DevTools → «Декриптор Happ» → «Установить декриптор».
Панель скачает:
- движок `happ-decrypt-universal-linux-<arch>` из релиза Xkeen-UI
  (ставится, только если совпала контрольная сумма из релиза);
- ключи Happ из репозитория LeeeeT/happ-decryptor по коммиту, закреплённому
  в манифесте панели (у каждого файла заданы размер и sha256).

Ключи Xkeen-UI не хранит и скачивает только по нажатию кнопки. Когда Happ
выпускает новые ключи, нажмите «Обновить ключи». Без интернета используйте
«Загрузить файл…»: подходят движок, `crypt5-keys.json`, `legacy_keys.json` или
`decrypt.js` из happ-decryptor.

При установке панели install.sh спрашивает, поставить ли декриптор (ответ по
умолчанию — «нет»). Без вопроса: `XKEEN_HAPP_DECRYPTOR_INSTALL=1 sh install.sh`.

Где лежат файлы
---------------

```text
/opt/etc/xkeen-ui/bin/happ-decrypt-universal          движок
/opt/etc/xkeen-ui/bin/happ-decrypt-universal.bak      прежний файл после переустановки
/opt/etc/xkeen-ui/bin/happ-decrypt-universal.assets/  ключи и сведения о них (happ-keys.json)
```

Проверка на роутере:

```sh
/opt/etc/xkeen-ui/bin/happ-decrypt-universal -version
/opt/etc/xkeen-ui/bin/happ-decrypt-universal -selftest
```

Настройки (DevTools → ENV)
--------------------------

- `XKEEN_HAPP_DECRYPTOR_RELEASE_URL` — откуда скачивать движок (своё зеркало релизов).
- `XKEEN_HAPP_KEYS_MANIFEST_URL` — откуда брать манифест ключей.
- `XKEEN_HAPP_DECRYPTOR_TIMEOUT` — таймаут декриптора: по умолчанию 15 с для движка
  и 45 с для скриптовых декрипторов.
- `XKEEN_HAPP_DECRYPTOR_CMD` — своя команда декриптора вместо найденного
  автоматически. XKeen передаёт ссылку последним аргументом или подставляет её
  вместо `%LINK%`; команда должна вывести URL подписки, текст подписки или JSON
  с полем `url`, `text`, `result`, `output`, `body` или `decrypted`.

Свои drop-in декрипторы
-----------------------

Если движка нет, панель ищет в `xkeen-ui/bin` и `xkeen-ui/scripts` файлы:
happ_decryptor.py, happ-decryptor.py, happ_decrypt_universal.py,
happ-decrypt-universal.py, happwner.py, Happwner.py, happ_decryptor,
happ-decryptor, happ_decrypt_universal, happ-decrypt-universal, happwner.
Установленный движок всегда важнее скриптов с этими именами.

Внешний сервис расшифровки
--------------------------

По умолчанию выключен. Включайте, только если осознанно доверяете сервису:
ссылка подписки уйдёт на удалённый сервер.

- JSON API: POST `{ "url": "happ://crypt..." }`, ответ JSON с `decryptedUrl`, `url` или `result`:
  `XKEEN_HAPP_DECRYPTOR_REMOTE_URL='https://example.com/api/decrypt'`
- GET-шаблон с `%LINK_ENCODED%` или `%LINK%`:
  `XKEEN_HAPP_DECRYPTOR_REMOTE_URL='https://happy-decoder.cc/p/%LINK_ENCODED%'`

Встроенный `scripts/happ_transport_helper.py` по-прежнему отвечает за HTTP(S)
landing page подписки Happ.
