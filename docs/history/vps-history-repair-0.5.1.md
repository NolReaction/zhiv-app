# Историческая смена checkout VPS для 0.5.1

> Однократная операция старого релиза. Это не инструкция обычного обновления или сброса текущей базы.

## Один раз синхронизировать VPS после замены истории master

Выполнить после публикации 0.5.1 в `origin/master`. Не сливать старую feature-ветку
с новым `master`: одинаковые файлы не означают общую историю коммитов.
Из обычной учётной записи, которой принадлежит checkout:

```bash
cd ~/zhiv-app
set -euo pipefail
umask 077
sync_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sync_backup="$(mktemp -d "$HOME/zhiv-before-051.XXXXXX")"
chmod 700 "$sync_backup"
if [[ -f deploy/.env ]]; then sudo cp -a deploy/.env "$sync_backup/deploy.env"; fi
if [[ -d deploy/.secrets ]]; then sudo cp -a deploy/.secrets "$sync_backup/deploy-secrets"; fi
git branch "backup/before-051-$sync_stamp" HEAD
git stash push --include-untracked -m "VPS before 0.5.1 $sync_stamp"
git fetch origin +refs/heads/master:refs/remotes/origin/master
git switch --create "deploy/0.5.1-$sync_stamp" --track origin/master
git log -1 --oneline
git status --short
printf 'Private configuration copy: %s\n' "$sync_backup"
```

Новая локальная ветка точно следует свежему `origin/master`; старые ветки
сохраняются. Изменённые отслеживаемые и неигнорируемые новые файлы попадают в
stash, игнорируемые `.env` и `.secrets` остаются на месте. Если секреты хранятся
по нестандартным путям из `.env`, они тоже остаются на месте; скопировать их
в закрытую копию отдельно. Не применять старый stash целиком: нужные изменения
конфигурации возвращать выборочно после просмотра. Не выполнять `git clean`.
Убедиться, что выведенный коммит — опубликованный 0.5.1 и его CI прошёл успешно.
