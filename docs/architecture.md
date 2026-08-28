# Архитектура и ERD

## Контур

```mermaid
flowchart TD
    PWA["React PWA"] -->|"HTTPS /api"| Caddy["Caddy"]
    Caddy --> Web["Next web"]
    Caddy --> API["Ktor API"]
    API --> DB["PostgreSQL 18"]
    API -.-> Push["Push provider · позже"]
```

- Web: React 19, Next 16; код совместим с текущим Vinext/Vite checkpoint.
- API: Kotlin 2.4.10, Ktor 3.5.2, JDK 25.
- Data: PostgreSQL 18, HikariCP, JDBC для явных транзакций, Flyway SQL migrations.
- Runtime: Docker Compose на одном VPS; Caddy завершает TLS и проксирует `/api/**`.

## ERD

```mermaid
erDiagram
    APP_USERS ||--o{ APP_SESSIONS : "имеет"
    APP_USERS ||--o{ IDENTITY_BOOTSTRAP_KEYS : "создан"
    APP_USERS ||--o{ CHECK_INS : "отмечается"
    APP_SESSIONS ||--o{ CHECK_INS : "создаёт"
    APP_USERS ||--o{ CIRCLES : "создаёт"
    APP_USERS ||--o{ CIRCLE_MEMBERSHIPS : "вступает"
    CIRCLES ||--o{ CIRCLE_MEMBERSHIPS : "содержит"
    CIRCLES ||--o{ CIRCLE_INVITES : "приглашает"
    APP_USERS ||--o{ DIRECT_REQUESTS : "запрашивает"
    APP_USERS ||--o{ CIRCLE_SHARING_PREFERENCES : "настраивает"
    CIRCLES ||--o{ CIRCLE_SHARING_PREFERENCES : "ограничивает"
    CHECK_INS ||--o{ CHECK_IN_AUDIENCES : "доступен"
    CIRCLES ||--o{ CHECK_IN_AUDIENCES : "контекст"
    APP_USERS ||--o{ CHECK_IN_AUDIENCES : "получает"

    APP_USERS {
        uuid id PK
        string public_id UK
        string display_name
        string timezone_id
        timestamptz last_check_in_at
    }
    APP_SESSIONS {
        uuid id PK
        uuid user_id FK
        bytea token_hash UK
        timestamptz expires_at
        timestamptz revoked_at
    }
    IDENTITY_BOOTSTRAP_KEYS {
        uuid id PK
        bytea idempotency_hash UK
        uuid user_id FK
        uuid session_id FK
        timestamptz expires_at
    }
    CHECK_INS {
        uuid id PK
        uuid user_id FK
        uuid session_id FK
        uuid idempotency_key UK
        timestamptz checked_at
        date local_date
    }
    CIRCLES {
        uuid id PK
        string kind
        string title
        uuid direct_user_low_id
        uuid direct_user_high_id
    }
    CIRCLE_MEMBERSHIPS {
        uuid id PK
        uuid circle_id FK
        uuid user_id FK
        string role
        timestamptz joined_at
        timestamptz left_at
    }
    DIRECT_REQUESTS {
        uuid id PK
        uuid requester_user_id FK
        uuid recipient_user_id FK
        string status
        uuid idempotency_key UK
        timestamptz expires_at
    }
    CIRCLE_SHARING_PREFERENCES {
        uuid circle_id PK
        uuid user_id PK
        string sharing_mode
        timestamptz enabled_since
        timestamptz updated_at
    }
    CIRCLE_INVITES {
        uuid id PK
        uuid circle_id FK
        bytea token_hash UK
        timestamptz expires_at
        string status
    }
    CHECK_IN_AUDIENCES {
        uuid check_in_id FK
        uuid circle_id FK
        uuid recipient_user_id FK
        uuid recipient_membership_id FK
        string access_level
    }
```

`DIRECT` хранит неизменяемую отсортированную пару пользователей прямо в `circles`, поэтому связь физически не может получить третьего участника. `GROUP` использует непересекающиеся исторические membership-строки: повторное вступление создаёт новую строку. Аудитория события содержит конкретного получателя и конкретный период membership — это исключает ретроактивную утечку истории. Requests и invites начинают только с `PENDING` и после терминального перехода не переписываются.

## HTTP 0.2

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/api/v1/bootstrap` | создать пользователя и cookie-сессию; нужен `Idempotency-Key` |
| `GET` | `/api/v1/me` | получить себя и последнюю отметку |
| `POST` | `/api/v1/check-ins` | создать отметку; нужен `Idempotency-Key` |
| `GET` | `/api/v1/users/{publicId}` | найти пользователя и состояние связи |
| `GET` | `/api/v1/people` | люди, заявки и число получателей следующей отметки |
| `POST` | `/api/v1/direct-requests` | отправить взаимную заявку |
| `POST` | `/api/v1/direct-requests/{id}/{action}` | `accept`, `reject` или `cancel` |
| `PATCH` | `/api/v1/people/{circleId}/sharing` | включить или выключить новые отметки |
| `DELETE` | `/api/v1/people/{circleId}` | архивировать личную связь |
| `GET` | `/healthz` | liveness процесса |

Все identity/check-in ответы имеют `Cache-Control: no-store`. Записывающие запросы сверяют `Origin`, bootstrap ограничен по размеру и частоте. Сырой session token не логируется; запросы выполняются через same-origin Caddy. Встроенный Next API — только in-memory dev-адаптер и в production fail-closed без явного `ENABLE_DEV_API=true`.

Повтор bootstrap с тем же случайным UUIDv4 не создаёт новые годовые сессии: в течение десяти минут он ротирует токен одной связанной session-строки. В PWA незавершённые bootstrap/check-in ключи и неизменный payload временно лежат в `sessionStorage`, чтобы reload после потерянного ответа не создавал дубль.

## Атомарность check-in

1. Найти сессию и заблокировать строку пользователя `FOR UPDATE`.
2. Проверить повтор `Idempotency-Key`.
3. Взять `clock_timestamp()` из PostgreSQL.
4. Проверить 30-секундное окно.
5. Вставить событие и снимки разрешённых получателей, обновить `last_check_in_at`.
6. Закоммитить всё одной транзакцией.

Дополнительно exclusion constraint в PostgreSQL запрещает пересекающиеся cooldown-интервалы даже при ошибке прикладного кода.
