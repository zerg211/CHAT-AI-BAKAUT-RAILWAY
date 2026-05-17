# Final production live gate diverse policy, 2026-05-17

## Что найдено

После введения spend guard production live-скрипты стали запускаться только по явным флагам, но `tests/remediationPostdeploy.mjs` при включенном live gate все еще запускал старые fixed replay сценарии:

- `test:live:production`;
- `test:live:production:876`.

Это противоречило новой рабочей политике: не гонять одинаковые диалоги после каждого исправления и не считать повтор одного сценария достаточным доказательством качества.

## Что изменено

Финальный postdeploy live gate теперь по умолчанию запускает только:

- `test:live:production:diverse`.

Старые replay-сценарии оставлены как отдельная ручная опция:

```bash
RUN_FIXED_PRODUCTION_REPLAYS=1
ALLOW_FIXED_PRODUCTION_REPLAY=1
```

Для стандартного финального diverse gate достаточно:

```bash
RUN_REMEDIATION_POSTDEPLOY_LIVE=1
ALLOW_PRODUCTION_LIVE_TESTS=1
FINAL_RELEASE_LIVE_GATE=1
```

`tests/liveAgentCycle.diverse.production.mjs` больше не требует `ALLOW_FIXED_PRODUCTION_REPLAY`, потому что это не fixed replay, а финальный varied buyer audit.

## Ожидаемый эффект

Финальная проверка перед production launch будет ближе к реальному качеству менеджера:

- разные формулировки;
- разные потребности;
- переключение между генератором, дизельным сценарием, двигателями, виброплитой, аксессуаром, доставкой/скидкой и отказом от звонка;
- проверка widget output плюс admin metadata.

Fixed replay сохраняется только для точечного regression-доказательства и не запускается автоматически.

## Проверка

Production live-диалоги не запускались.

Локальные проверки:

- `tests/productionLiveGate.test.ts` расширен сценарием, где diverse final audit разрешен без fixed replay approval;
- predeploy gate проверяет синтаксис всех production live scripts и postdeploy orchestration.
