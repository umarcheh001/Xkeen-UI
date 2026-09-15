# happ-decrypt-universal

Расшифровывает ссылки подписок Happ (`happ://crypt/…`, `crypt2`, `crypt3`, `crypt4`, `crypt5`) и печатает адрес
подписки. Один статический файл на Go без cgo, Node и эмулятора: на роутере arm64 `crypt5` занимает около 0,07 с
и 4 МиБ памяти.

**Ключей Happ в этом каталоге нет.** Программа читает их при запуске из каталога ключей:

| Файл | Содержимое |
|---|---|
| `crypt5-keys.json` | объект «маркер из 8 символов → закрытый ключ RSA в PKCS#8, base64» |
| `legacy_keys.json` | список из четырёх закрытых ключей RSA в PKCS#1, base64 — для `crypt`, `crypt2`, `crypt3`, `crypt4` |

Каталог ищется так: флаг `-assets`, затем переменная `HAPP_DECRYPT_ASSETS`, затем `<путь к бинарнику>.assets/`
(для панели — `xkeen-ui/bin/happ-decrypt-universal.assets/`).

## Запуск

```sh
happ-decrypt-universal 'happ://crypt5/…'      # ссылка аргументом
happ-decrypt-universal @link.txt              # ссылка из файла
echo 'happ://crypt4/…' | happ-decrypt-universal
happ-decrypt-universal -json 'happ://crypt5/…'
happ-decrypt-universal -selftest              # какие файлы на месте, сколько ключей, хэш набора
happ-decrypt-universal -version
```

По умолчанию в stdout — только расшифрованный адрес: панель (`services/happ_links.py`) разбирает его как есть.
С `-json` — `{"ok":true,"format":"crypt5","layout":"salted","url":"…"}` или
`{"ok":false,"error":"unknown_key","message":"…"}`.

| Код выхода | `error` | Что значит |
|---|---|---|
| 0 | — | готово |
| 1 | `bad_link`, `corrupt` | ссылка повреждена: неверная структура или не сходится расшифровка |
| 2 | — | неверный вызов |
| 3 | `no_keys` | нет файлов ключей или они не читаются |
| 4 | `unknown_key` | для ссылки нет ключа — обновите ключи Happ |

## Формат crypt5

Полезная нагрузка — ASCII. В каждой полной группе из четырёх байт половины меняются местами (`ABCD` → `CDAB`),
после чего строка читается как `маркер[0:4] | тело | маркер[4:8]`. Маркер выбирает ключ RSA. Тело бывает двух видов:

```
обычное: nonce(12) |                    длина | разделитель | sealedURL | wrappedKey
солёное: nonce(12) | метка(2) | соль(8) | длина | разделитель | sealedURL | wrappedKey

sealedURL  = base64(ChaCha20-Poly1305(contentKey, nonce, swapPairs(base64(url))))
wrappedKey = base64(RSA-PKCS1v15(swapPairs(base64(contentKey XOR соль))))
```

`длина` — десятичный размер `sealedURL`; в обычном теле XOR с солью нет; `swapPairs` меняет местами соседние байты.
Сразу после nonce цифра стоит только в обычном теле — по этому признаку выбирается, какой вид пробовать первым.

`crypt`…`crypt4`: base64 от блоков RSA PKCS#1 v1.5 размером в ключ, открытые тексты склеиваются.

## Разработка

```sh
go test ./...
./build.sh                                            # под текущую систему
GOOS=linux GOARCH=arm64 OUT=./happ-decrypt-universal-arm64 ./build.sh
GOOS=linux GOARCH=mipsle GOMIPS=softfloat OUT=./happ-decrypt-universal-mipsle ./build.sh
```

Тесты создают свои ключи RSA и шифруют ссылки в форматах Happ сами. Проверка на настоящих файлах и ссылках
необязательна и включается переменными (см. `internal/happ/genuine_test.go`):

```sh
HAPP_DECRYPT_TEST_ASSETS=/путь/к/ключам HAPP_DECRYPT_TEST_CASES=/путь/cases.json go test ./internal/happ
```

## Благодарности

Формат ссылок Happ разобран в исследовании [LeeeeT/happ-decryptor](https://github.com/LeeeeT/happ-decryptor).
Этот движок написан заново по описанию формата; кода и ключей из того репозитория здесь нет.
