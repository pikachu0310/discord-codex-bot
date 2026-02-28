#!/usr/bin/env python3
"""
codex-ratelimit 互換の最小チェッカー。

https://github.com/xiangz19/codex-ratelimit の JSON 出力形式を参考に、
Discord プレゼンス表示に必要な情報だけを抽出する。
"""

import argparse
import glob
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


def get_session_base_path(custom_path: Optional[str] = None) -> Path:
    if custom_path:
        return Path(custom_path).expanduser()
    return Path.home() / ".codex" / "sessions"


def get_session_files(base_path: Path, days_back: int = 7) -> list:
    files = []
    now = datetime.now()

    for offset in range(days_back):
        target = now - timedelta(days=offset)
        date_dir = base_path / str(target.year) / f"{target.month:02d}" / f"{target.day:02d}"
        if not date_dir.exists():
            continue

        for file_path in glob.glob(str(date_dir / "rollout-*.jsonl")):
            path = Path(file_path)
            try:
                files.append((path, path.stat().st_mtime))
            except OSError:
                continue

    files.sort(key=lambda item: item[1], reverse=True)
    return files


def validate_record(record: Dict[str, Any]) -> bool:
    try:
        payload = record.get("payload")
        info = payload.get("info")
        return (
            record.get("type") == "event_msg"
            and payload.get("type") == "token_count"
            and isinstance(record.get("timestamp"), str)
            and isinstance(info.get("total_token_usage"), dict)
            and isinstance(info.get("last_token_usage"), dict)
        )
    except Exception:
        return False


def parse_session_file(file_path: Path) -> Optional[Dict[str, Any]]:
    latest_record = None
    latest_timestamp = None

    try:
        with file_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue

                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                if not validate_record(record):
                    continue

                timestamp = parse_timestamp(record["timestamp"])
                if timestamp is None:
                    continue

                if latest_timestamp is None or timestamp > latest_timestamp:
                    latest_timestamp = timestamp
                    latest_record = record
    except OSError:
        return None

    return latest_record


def find_latest_record(base_path: Path) -> Optional[Tuple[Path, Dict[str, Any]]]:
    for file_path, _mtime in get_session_files(base_path):
        record = parse_session_file(file_path)
        if record is not None:
            return file_path, record
    return None


def parse_timestamp(value: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def calculate_reset(rate_limit: Dict[str, Any], record_timestamp: datetime) -> Tuple[datetime, int, bool]:
    tzinfo = record_timestamp.tzinfo
    reset_time = None

    resets_at = rate_limit.get("resets_at")
    if resets_at is not None:
        try:
            reset_time = datetime.fromtimestamp(float(resets_at), tz=tzinfo)
        except (TypeError, ValueError, OSError, OverflowError):
            reset_time = None

    if reset_time is None:
        resets_in_seconds = rate_limit.get("resets_in_seconds")
        if resets_in_seconds is not None:
            try:
                reset_time = record_timestamp + timedelta(seconds=float(resets_in_seconds))
            except (TypeError, ValueError, OverflowError):
                reset_time = None

    if reset_time is None:
        reset_time = record_timestamp

    current_time = datetime.now(tzinfo)
    remaining_seconds = int(round(max(0.0, (reset_time - current_time).total_seconds())))
    outdated = reset_time <= current_time

    return reset_time, remaining_seconds, outdated


def build_limit_output(rate_limit: Dict[str, Any], record_timestamp: datetime) -> Dict[str, Any]:
    reset_time, seconds_until_reset, outdated = calculate_reset(rate_limit, record_timestamp)
    used_percent = rate_limit.get("used_percent", 0)

    try:
        used_percent = float(used_percent)
    except (TypeError, ValueError):
        used_percent = 0.0

    return {
        "used_percent": used_percent,
        "reset_time": reset_time.astimezone().strftime("%Y-%m-%d %H:%M:%S"),
        "seconds_until_reset": seconds_until_reset,
        "outdated": outdated,
        "resets_at": rate_limit.get("resets_at"),
        "resets_in_seconds": rate_limit.get("resets_in_seconds"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Codex rate limits from local session files")
    parser.add_argument("--input-folder", "-i", type=str, help="Custom session directory")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    args = parser.parse_args()

    base_path = get_session_base_path(args.input_folder)
    result = find_latest_record(base_path)

    if result is None:
        payload = {"error": "No token_count events found in session files"}
        if args.json:
            print(json.dumps(payload))
        else:
            print(payload["error"])
        return 0

    file_path, record = result
    payload = record["payload"]
    info = payload["info"]
    rate_limits = payload.get("rate_limits", {})
    record_timestamp = parse_timestamp(record["timestamp"])

    if record_timestamp is None:
        error_payload = {"error": "Invalid record timestamp"}
        print(json.dumps(error_payload) if args.json else error_payload["error"])
        return 0

    total_usage = info["total_token_usage"]
    last_usage = info["last_token_usage"]

    output = {
        "total": {
            "input": total_usage.get("input_tokens", 0),
            "cached": total_usage.get("cached_input_tokens", 0),
            "output": total_usage.get("output_tokens", 0),
            "reasoning": total_usage.get("reasoning_output_tokens", 0),
            "subtotal": total_usage.get("total_tokens", 0),
        },
        "last": {
            "input": last_usage.get("input_tokens", 0),
            "cached": last_usage.get("cached_input_tokens", 0),
            "output": last_usage.get("output_tokens", 0),
            "reasoning": last_usage.get("reasoning_output_tokens", 0),
            "subtotal": last_usage.get("total_tokens", 0),
        },
        "source_file": str(file_path),
    }

    primary = rate_limits.get("primary")
    if isinstance(primary, dict):
        output["limit_5h"] = build_limit_output(primary, record_timestamp)

    secondary = rate_limits.get("secondary")
    if isinstance(secondary, dict):
        output["limit_weekly"] = build_limit_output(secondary, record_timestamp)

    if args.json:
        print(json.dumps(output))
        return 0

    print(f"source_file: {file_path}")
    if "limit_5h" in output:
        print(f"5h: {output['limit_5h']}")
    if "limit_weekly" in output:
        print(f"1w: {output['limit_weekly']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
