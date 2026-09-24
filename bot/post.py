#!/usr/bin/env python3
"""Публикация текстового поста в Telegram-канал через Bot API."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BOT_DIR = Path(__file__).resolve().parent
ENV_FILE = BOT_DIR / ".env"
PUBLISHED_LOG = BOT_DIR / "published.jsonl"


def load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def get_credentials() -> tuple[str, str]:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHANNEL_ID")
    if not token or not chat_id:
        load_dotenv(ENV_FILE)
        token = token or os.environ.get("TELEGRAM_BOT_TOKEN")
        chat_id = chat_id or os.environ.get("TELEGRAM_CHANNEL_ID")
    if not token or not chat_id:
        sys.exit(
            "Не заданы TELEGRAM_BOT_TOKEN и/или TELEGRAM_CHANNEL_ID "
            "(переменные окружения или bot/.env)"
        )
    return token, chat_id


def read_text() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    text = sys.stdin.read()
    if not text.strip():
        sys.exit("Текст поста не передан (аргумент командной строки или stdin)")
    return text


def send_message(token: str, chat_id: str, text: str) -> dict:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    ).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        try:
            description = json.loads(body).get("description", body)
        except json.JSONDecodeError:
            description = body
        sys.exit(f"Ошибка Telegram API: {error.code} {description}")
    except urllib.error.URLError as error:
        sys.exit(f"Ошибка сети: {error.reason}")


def log_published(message_id: int, text: str) -> None:
    entry = {
        "message_id": message_id,
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "text_preview": text[:80],
    }
    with PUBLISHED_LOG.open("a", encoding="utf-8") as log_file:
        log_file.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main() -> None:
    token, chat_id = get_credentials()
    text = read_text()
    result = send_message(token, chat_id, text)
    if not result.get("ok"):
        error_code = result.get("error_code", "?")
        description = result.get("description", "неизвестная ошибка")
        sys.exit(f"Ошибка Telegram API: {error_code} {description}")
    message_id = result["result"]["message_id"]
    log_published(message_id, text)
    print(f"Опубликовано: message_id={message_id}")


if __name__ == "__main__":
    main()
