# pi-zai-router

Расширение [Pi coding agent](https://pi.dev): виртуальная модель `<provider>/auto`
для подписки z.ai. Вместо ручного выбора модели сессия стартует на `auto`,
а расширение маршрутизирует запросы между моделями провайдера по фазе работы.

## Как маршрутизирует

| Ситуация | Модель |
| --- | --- |
| Новая задача: Jev-классификатор оценил запрос как `complex` (тонкий дизайн, сквозные изменения, тяжёлый дебаг) | complex-модель (по умолчанию `glm-5.3`) |
| Новая задача: `standard` (обычные фичи, фиксы, ревью, вопросы) — или Jev недоступен | fast-модель (по умолчанию `glm-5.3-flash`) |
| Первая успешная правка (edit/write) после фазы планирования | остаток хода уходит на fast-модель и сессия остаётся на ней (один промпт-кэш-мисс) |
| В сообщениях есть картинки | fast-модель (vision, 1M контекста); complex-модель картинки не принимает |
| Служебные запросы вне агентного цикла (компакция и т.п.) | fast-модель |

Выбор уровня thinking передаётся выбранной модели как есть. Если сессия уже
работает на одной из моделей роутера — повторная классификация не выполняется,
чтобы не платить промпт-кэш-мисс.

## Требования

- Ключ подписки z.ai — в `~/.pi/agent/auth.json`, секция `"zai"`.
- (Опционально) ключ Jev-классификатора `typesafe`: env `TYPESAFE_API_KEY`
  или секция `"typesafe"` в `auth.json`. Без него роутер сразу выбирает
  fast-модель — работать не перестаёт.
- Модели complex/fast должны существовать в каталоге провайдера (см. ниже).

## Установка

```bash
pi install git:github.com/rybushkindmitry/pi-zai-router@v1
```

Пакет подключается в `~/.pi/agent/settings.json` (`packages`) и действует
во всех проектах. Обновление: `pi update --extensions`.

## Настройка машины (одноразовая)

Код в пакете, деплой-политика — в локальных настройках. В
`~/.pi/agent/models.json` нужен провайдер с обеими моделями:

```json
{
  "providers": {
    "zai": {
      "models": [
        {
          "id": "glm-5.3",
          "name": "GLM-5.3",
          "api": "openai-completions",
          "provider": "zai",
          "baseUrl": "https://api.z.ai/api/coding/paas/v4",
          "reasoning": true,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "compat": {
            "supportsStore": false,
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": true,
            "maxTokensField": "max_tokens",
            "thinkingFormat": "zai",
            "zaiToolStream": true
          },
          "contextWindow": 1000000,
          "maxTokens": 131072,
          "thinkingLevelMap": {
            "off": null, "minimal": null, "low": "low", "medium": null,
            "high": "high", "xhigh": null, "max": "max"
          }
        },
        {
          "id": "glm-5.3-flash",
          "name": "GLM-5.3 Flash",
          "api": "openai-completions",
          "provider": "zai",
          "baseUrl": "https://api.z.ai/api/coding/paas/v4",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "compat": {
            "supportsStore": false,
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": true,
            "maxTokensField": "max_tokens",
            "thinkingFormat": "zai",
            "zaiToolStream": true
          },
          "contextWindow": 1000000,
          "maxTokens": 131072,
          "thinkingLevelMap": {
            "off": null, "minimal": null, "low": "low", "medium": null,
            "high": "high", "xhigh": null, "max": "max"
          }
        }
      ]
    }
  }
}
```

Лимиты (`contextWindow`/`maxTokens`) поправьте под свою подписку.

В `~/.pi/agent/settings.json` сделать `auto` моделью по умолчанию:

```json
{
  "defaultProvider": "zai",
  "defaultModel": "auto"
}
```

Опционально — закрепить сильную модель за ревью-сабагентами (pi-subagents):

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": { "thinking": "high" }
    },
    "agentOverridesByProvider": {
      "zai": {
        "reviewer": { "model": "zai/glm-5.3" }
      }
    }
  }
}
```

## Переменные окружения

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `ZAI_ROUTER_PROVIDER` | `zai` | провайдер каталога моделей |
| `ZAI_ROUTER_COMPLEX_MODEL` | `glm-5.3` | модель планирования |
| `ZAI_ROUTER_FAST_MODEL` | `glm-5.3-flash` | модель реализации, картинок и compaction |
| `ZAI_ROUTER_QUIET` | — | `1` отключает диагностический лог |

## Диагностика

Решения роутера пишутся в `~/.pi/agent/zai-router.log`:

```text
2026-10-06T12:01:41.158Z route reason=continuation branch=sticky(planning) -> glm-5.3-flash:high (0ms)
```

## Разработка

Расширение — один TypeScript-файл (`extensions/zai-router.ts`). Типы
`@earendil-works/pi-ai` и `@earendil-works/pi-coding-agent` предоставляет хост
(объявлены в `peerDependencies` со спецификатором `"*"` — не бандлить).
Проверить без установки: `pi -e ./extensions/zai-router.ts`.

## Лицензия

MIT
