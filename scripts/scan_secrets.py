#!/usr/bin/env python3
"""Поиск секретов в файлах под контролем версий (часть P0-04).

Проверяет рабочее дерево, а не историю: назначение — не дать секрету попасть в
коммит, пока он ещё правится. Уже утекший ключ этим не лечится, его нужно
отзывать, поэтому найденная строка означает ротацию, а не только правку файла.

Скрипт не заменяет полноценный сканер (gitleaks, trufflehog) и не доказывает
отсутствие секретов: он ловит известные формы. Это дешёвая проверка перед
коммитом, а не гарантия.

Выход: 0 — находок нет, 2 — есть находки, 1 — ошибка запуска.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Значения, которые выглядят как секрет, но являются заглушкой в примерах.
PLACEHOLDERS = re.compile(
    r"ЗАМЕНИТЬ|CHANGEME|CHANGE_ME|REPLACE|EXAMPLE|PLACEHOLDER|<[^>]+>|\.\.\.|xxx+|ЗДЕСЬ",
    re.IGNORECASE,
)

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("Приватный ключ", re.compile(r"-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY")),
    ("Ключ OpenAI", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("Ключ доступа AWS", re.compile(r"\b(AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("Токен GitHub", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("Пароль в строке подключения", re.compile(r"://[^\s:/@]+:[^\s:/@]+@")),
    (
        "Присвоение секрета",
        re.compile(
            r"(?i)\b(api[_-]?key|secret|password|passwd|token|client[_-]?secret)\b\s*[=:]\s*['\"]?[A-Za-z0-9/+_-]{16,}"
        ),
    ),
]

# Файлы, где длинные строки ожидаемы и не являются секретами.
SKIP_SUFFIXES = {".lock", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".ico", ".woff", ".woff2"}
SKIP_NAMES = {"package-lock.json", "scan_secrets.py"}


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        capture_output=True,
        check=True,
        timeout=30,
    )
    names = [name for name in result.stdout.decode("utf-8").split("\0") if name]
    return [ROOT / name for name in names]


def scan_file(path: Path) -> list[tuple[int, str, str]]:
    if path.name in SKIP_NAMES or path.suffix.lower() in SKIP_SUFFIXES:
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
        return []

    findings: list[tuple[int, str, str]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        for label, pattern in PATTERNS:
            match = pattern.search(line)
            if match is None:
                continue
            # Заглушка проверяется по найденному значению, а не по всей строке.
            # При проверке строки целиком настоящий пароль в
            # postgres://user:пароль@db.example.com пропускался из-за слова
            # example в имени хоста — это нашёл положительный контроль.
            if PLACEHOLDERS.search(match.group(0)):
                continue
            # Само значение не печатается: вывод проверки попадает в логи CI.
            findings.append((number, label, match.group(0)[:6] + "…"))
    return findings


def main() -> int:
    try:
        files = tracked_files()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"Не удалось получить список файлов git: {error}", file=sys.stderr)
        return 1

    total = 0
    for path in files:
        for number, label, sample in scan_file(path):
            total += 1
            print(f"{path.relative_to(ROOT)}:{number}: {label} ({sample})")

    env_tracked = [p for p in files if p.name == ".env" or p.name.startswith(".env.")]
    for path in env_tracked:
        if path.name != ".env.example":
            total += 1
            print(f"{path.relative_to(ROOT)}: файл окружения под контролем версий")

    if total > 0:
        print(f"\nНайдено потенциальных секретов: {total}. Проверить и при подтверждении отозвать ключ.")
        return 2

    print(f"Секретов известных форм не найдено; проверено файлов: {len(files)}.")
    print("Это не доказательство их отсутствия: проверяются только известные формы и рабочее дерево, не история.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
