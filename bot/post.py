#!/usr/bin/env python3
"""Публикация сообщения в Telegram-канал через Bot API."""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")


def load_env_file(path):
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                values[key] = value
    except FileNotFoundError:
        pass
    return values


def get_config():
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHANNEL_ID")

    if not token or not chat_id:
        env_values = load_env_file(ENV_FILE)
        token = token or env_values.get("TELEGRAM_BOT_TOKEN")
        chat_id = chat_id or env_values.get("TELEGRAM_CHANNEL_ID")

    if not token or not chat_id:
        print(
            "Ошибка: не заданы TELEGRAM_BOT_TOKEN и/или TELEGRAM_CHANNEL_ID "
            "(переменные окружения или bot/.env)",
            file=sys.stderr,
        )
        sys.exit(1)

    return token, chat_id


def get_text():
    if len(sys.argv) > 1:
        return " ".join(sys.argv[1:])
    text = sys.stdin.read().strip()
    if not text:
        print("Ошибка: не передан текст поста (аргумент или stdin)", file=sys.stderr)
        sys.exit(1)
    return text


def send_message(token, chat_id, text):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    ).encode("utf-8")
    request = urllib.request.Request(url, data=payload, method="POST")

    try:
        with urllib.request.urlopen(request) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = json.loads(e.read().decode("utf-8"))
        print(
            f"Ошибка Telegram API: код {body.get('error_code', e.code)}, "
            f"описание: {body.get('description', 'нет описания')}",
            file=sys.stderr,
        )
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Ошибка сети: {e.reason}", file=sys.stderr)
        sys.exit(1)

    if not body.get("ok"):
        print(
            f"Ошибка Telegram API: код {body.get('error_code')}, "
            f"описание: {body.get('description', 'нет описания')}",
            file=sys.stderr,
        )
        sys.exit(1)

    print("Сообщение опубликовано.")


def main():
    token, chat_id = get_config()
    text = get_text()
    send_message(token, chat_id, text)


if __name__ == "__main__":
    main()
