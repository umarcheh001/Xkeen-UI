# Этап 3R.1.6. Baseline initial HTML

Статус: **закрыт 30 сентября 2026 года**.

Baseline зафиксирован до подэтапа 4.3, который начнёт переносить screen
markup из composition root в отдельные partials.

## Источник

- entrypoint: `xkeen-ui/templates/panel.html`;
- composed source: `scripts/panel_template_source.py`;
- raw SHA-256: `38b6b66753297f8119b40dc927d07148011283f6f6bbd0ed706077bbbcc68ff0`;
- composed SHA-256: `2c3cd8f374f949384859e759ae1646781ebee794992a3d2dc49500a1f12ea82e`;
- composed UTF-8: `425148` байт;
- строк: `5608`;
- DOM id: `1348`, дубликатов: `0`.

## Профили

| Профиль | Ожидаемые screens | Navigation sections | Modal allow | Modal deny |
|---|---|---|---:|---:|
| `legacy-full` | routing, mihomo, xkeen, xray-logs, commands, files | routing, mihomo, xkeen, xray-logs, commands, files, mihomo-generator, devtools, donate | 53 | 0 |
| `full` | routing, mihomo, xkeen, xray-logs, commands, files | routing, mihomo, xkeen, xray-logs, commands, files, mihomo-generator, devtools, donate | 53 | 0 |
| `xray-only` | routing, xkeen, xray-logs | routing, xkeen, xray-logs, donate | 20 | 33 |
| `mihomo-only` | mihomo, xkeen | mihomo, xkeen, mihomo-generator, donate | 12 | 41 |

## Воспроизведение

```powershell
python .\scripts\generate_modular_panel_stage3r1_baseline.py --root .
```

Это структурный HTML baseline. Замеры Network/RSS/startup остаются
в Этапе 10 и требуют запуска панели на целевом роутере.
