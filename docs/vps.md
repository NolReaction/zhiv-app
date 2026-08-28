# VPS в РФ

Проверено 28 августа 2026 года. Для первой версии достаточно 2 vCPU, 4 ГБ RAM и 40–50 ГБ NVMe.

| Провайдер | Конфигурация | Ориентир | Бэкап | Вывод |
|---|---|---:|---|---|
| Timeweb Cloud, Москва | 2 vCPU / 4 ГБ / 50 ГБ | ≈ 1 650 ₽/мес с IPv4 и одной 50-ГБ копией | managed по расписанию | основной вариант: меньше ручного DevOps |
| Beget, Санкт-Петербург | 2 vCPU / 4 ГБ / 40 ГБ | ≈ 1 140 ₽ за 30 дней с IPv4 | бесплатный файловый, не образ БД | нормальный запасной вариант |
| Selectel VDS, Москва/СПб | 2 vCPU / 4 ГБ / 50 ГБ | 650 ₽/мес, IPv4 включён | настраиваем сами | самый бюджетный, нужен `pg_dump` в отдельное хранилище |

Источники: [Timeweb VPS](https://timeweb.cloud/services/vps-linux), [Timeweb backup](https://timeweb.cloud/docs/cloud-servers/manage-servers/backup), [Beget VPS](https://beget.com/ru/vps), [Beget backup](https://beget.com/ru/kb/how-to/other/backup-i-snapshot-v-chyom-raznica), [Selectel VDS](https://selectel.ru/services/cloud/vps-vds/), [ограничения VDS backup](https://docs.selectel.ru/vds-servers/about/about-vds-server/).

Решение на старт: **Timeweb Cloud Москва**. Если хочется проверить спрос максимально дёшево — **Selectel**, но в тот же день настроить ежедневный зашифрованный `pg_dump`, выгрузку в отдельный S3 и тест восстановления.

Минимальный production checklist:

- домен и DNS на VPS;
- Ubuntu LTS, SSH key only, отдельный deploy-user;
- закрыты все входящие порты кроме 22, 80, 443;
- PostgreSQL наружу не опубликован;
- длинный случайный пароль БД в `deploy/.env`, сам файл не коммитится;
- ежедневный backup вне VPS и ежемесячная проверка restore;
- обновления образов, disk/uptime alerts и ротация логов.
