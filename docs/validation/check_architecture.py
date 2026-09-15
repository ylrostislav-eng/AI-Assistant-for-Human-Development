#!/usr/bin/env python3
"""Validate planning artifacts and arithmetic, not the future application.

Standard library only. The small rational calculator covers documented reward
examples, not production evidence, rolling caps, ledger, sync, or authorization.
"""

from __future__ import annotations

import argparse
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import random
import re


ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
# Контракты и коэффициенты переехали из docs/contracts в production-расположение
# (P1-01). Двух канонических копий быть не должно, поэтому проверка читает
# только новые пути.
CONTRACT_SCHEMAS = ROOT / "packages/contracts/schemas"
RULES = ROOT / "packages/rules/progression"
CONFIG = json.loads((RULES / "progression-v0.1.json").read_text())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def rational(value: int | float | str) -> Fraction:
    return Fraction(str(value))


def threshold(level: int, kind: str = "lifetime") -> int:
    coefficients = CONFIG["levels"][kind]
    return (
        coefficients["linear_mxp"] * level
        + coefficients["quadratic_mxp"] * level**2
        + coefficients["cubic_mxp"] * level**3
    )


def level_at(xp_mxp: int, kind: str = "lifetime") -> int:
    low, high = 0, 1
    while threshold(high, kind) <= xp_mxp:
        high *= 2
    while low + 1 < high:
        middle = (low + high) // 2
        if threshold(middle, kind) <= xp_mxp:
            low = middle
        else:
            high = middle
    return low


def band_at(seconds: int, bands: list[dict]) -> tuple[int | None, Fraction]:
    for band in bands:
        end = band["end_minutes"]
        if end is None or seconds < end * 60:
            return (None if end is None else end * 60, rational(band["multiplier"]))
    raise ValueError("Bands must end with an unbounded zero band")


def base_xp(seconds: int, family_before: int = 0, global_before: int = 0) -> Fraction:
    """Exact integral for a single non-overlapping same-family activity."""
    total = Fraction(0)
    remaining = seconds
    while remaining:
        family_end, family_rate = band_at(family_before, CONFIG["reward"]["family_bands"])
        global_end, global_rate = band_at(global_before, CONFIG["reward"]["global_bands"])
        widths = [remaining]
        if family_end is not None:
            widths.append(family_end - family_before)
        if global_end is not None:
            widths.append(global_end - global_before)
        width = min(widths)
        total += Fraction(width, 60) * rational(CONFIG["reward"]["base_xp_per_minute"]) * family_rate * global_rate
        family_before += width
        global_before += width
        remaining -= width
    return total


def floor_mxp(xp: Fraction) -> int:
    return math.floor(xp * CONFIG["milli_xp_per_xp"])


def strict_objects(schema: dict) -> None:
    if schema.get("type") == "object":
        require(schema.get("additionalProperties") is False, "Strict tool object allows extra fields")
        require(set(schema["required"]) == set(schema["properties"]), "Strict tool fields must be required")
        for child in schema["properties"].values():
            strict_objects(child)
    if "items" in schema:
        strict_objects(schema["items"])


def validate_documents() -> tuple[int, int, str]:
    source = DOCS / "source/original-concept.ru.md"
    source_text = source.read_text()
    numbers = [int(n) for n in re.findall(r"^# (\d+)\.", source_text, flags=re.M)]
    require(numbers == list(range(1, 78)), "Original concept must contain sections 1..77")
    coverage = (DOCS / "12-traceability-and-sources.md").read_text()
    sections = coverage.split("## 2. Все 77 разделов концепции", 1)[1].split("## 3.", 1)[0]
    technical = coverage.split("## 3. Все 32 технических пункта", 1)[1].split("## 4.", 1)[0]
    for body, maximum in [(sections, 77), (technical, 32)]:
        found = [int(n) for n in re.findall(r"^\| (\d+) \|", body, flags=re.M)]
        require(found == list(range(1, maximum + 1)), f"Coverage gap for {maximum} requirements")

    paths = [ROOT / "README.md", ROOT / "AGENTS.md", *sorted(DOCS.rglob("*.md"))]
    link_count = 0
    for path in paths:
        content = path.read_text()
        fences = re.findall(r"^```", content, flags=re.M)
        require(len(fences) % 2 == 0, f"Unbalanced code fences: {path}")
        for target in re.findall(r"\[[^\]]*\]\(([^\s)]+)\)", content):
            if "://" in target or target.startswith("#"):
                continue
            target = target.split("#", 1)[0]
            require((path.parent / target).exists(), f"Broken local link: {path.name} -> {target}")
            link_count += 1
    for path in sorted([*CONTRACT_SCHEMAS.glob("*.json"), *RULES.glob("*.json")]):
        json.loads(path.read_text())
    tool = json.loads((CONTRACT_SCHEMAS / "complete-quest.tool.json").read_text())
    require(tool["strict"] is True, "Strict tool mode is required")
    strict_objects(tool["parameters"])
    require(not {"xp", "level", "rank", "user_id"} & set(tool["parameters"]["properties"]), "Forbidden tool fields")
    return len(paths), link_count, hashlib.sha256(source.read_bytes()).hexdigest()


def validate_math() -> dict[str, int]:
    current = CONFIG["current_power"]
    weights = [current[key] for key in ["form_weight", "activity_weight", "adherence_weight", "regularity_weight"]]
    require(sum(map(rational, weights)) == 1, "Power weights must total one")
    require(CONFIG["form"]["mastery_decay"] == 0, "v1 mastery must not decay")
    require(CONFIG["recovery"]["recursive_debt"] is False, "Recursive recovery debt forbidden")
    for kind in ["lifetime", "skill"]:
        previous = -1
        for level in range(1001):
            t = threshold(level, kind)
            require(t > previous, f"Non-increasing {kind} threshold")
            require(level_at(t, kind) == level, f"Threshold inverse: {kind}/{level}")
            if level:
                require(level_at(t - 1, kind) == level - 1, f"Boundary inverse: {kind}/{level}")
            previous = t

    examples = {
        "45min_C_self": floor_mxp(base_xp(45 * 60)),
        "15min_minimum_C_self": floor_mxp(base_xp(15 * 60)),
        "45min_B_timer": floor_mxp(base_xp(45 * 60) * rational(CONFIG["reward"]["difficulty"]["B"]) * rational(CONFIG["reward"]["evidence"]["timer"])),
        "90min_same_family": floor_mxp(base_xp(90 * 60)),
        "180min_same_family": floor_mxp(base_xp(180 * 60)),
        "100min_same_family": floor_mxp(base_xp(100 * 60)),
    }
    expected = {
        "45min_C_self": 22500, "15min_minimum_C_self": 7500,
        "45min_B_timer": 27540, "90min_same_family": 37500,
        "180min_same_family": 48750, "100min_same_family": 40000,
    }
    require(examples == expected, f"Documented examples differ: {examples}")

    rng = random.Random(20260915)
    for _ in range(250):
        duration = rng.randint(1, 24 * 3600)
        family_start = rng.randint(0, 120 * 60)
        global_start = rng.randint(0, 240 * 60)
        cuts = sorted({0, duration, *(rng.randrange(duration + 1) for _ in range(100))})
        pieces = sum((base_xp(b - a, family_start + a, global_start + a) for a, b in zip(cuts, cuts[1:])), Fraction(0))
        whole = base_xp(duration, family_start, global_start)
        require(pieces == whole, "Splitting changed exact bucket integral")
        require(floor_mxp(pieces) == floor_mxp(whole), "Splitting changed milli-XP")

    for half_life in CONFIG["form"]["half_life_days"].values():
        decay = 2 ** (-1 / half_life)
        require(math.isclose(decay**half_life, 0.5, abs_tol=1e-12), "Half-life arithmetic")
    cap_mxp = CONFIG["reward"]["daily_cap_xp"] * 1000
    require(math.ceil(threshold(100) / cap_mxp) == 1845, "Level 100 lower bound changed")
    for level in range(101):
        for percentage in range(101):
            power = Fraction(percentage, 100)
            current_level = math.floor(level * (rational(current["current_level_floor_ratio"]) + rational(current["current_level_power_ratio"]) * power))
            require(0 <= current_level <= level, "CurrentLevel outside Lifetime bounds")
    return examples


def report(examples: dict[str, int]) -> str:
    rows = [
        "# Проверка математического баланса v0.1", "",
        "Сгенерировано `python3 docs/validation/check_architecture.py --write-report`.", "",
        "Это проверка формул архитектуры. Production engine, rolling-window replay, iOS, API и базы данных ещё не реализованы и этим отчётом не проверяются.", "",
        "## Сроки роста", "",
        "Постоянный уже начисленный XP, без перерывов; дни округлены вверх.", "",
        "| Level | Lifetime XP | 30 XP/day | 70 XP/day | 120 XP/day |",
        "|---:|---:|---:|---:|---:|",
    ]
    for level in CONFIG["calibration"]["report_levels"]:
        t = threshold(level)
        days = [math.ceil(Fraction(t, daily * 1000)) for daily in CONFIG["calibration"]["daily_xp_scenarios"]]
        rows.append(f"| {level} | {t / 1000:g} | {days[0]} | {days[1]} | {days[2]} |")
    rows += ["", "Level 100 при максимуме 180 XP/day: минимум 1845 наградных дней (около 5.05 года).", "", "## Награды из примеров", "", "| Пример | milli-XP | XP |", "|---|---:|---:|"]
    rows += [f"| {name} | {value} | {value / 1000:.3f} |" for name, value in examples.items()]
    rows += ["", "## Выполненные проверки", "",
             "- Пороги и обратная функция: Lifetime/Skill Level 0–1000, включая T(L)−1 milli-XP.",
             "- 250 воспроизводимых случаев разбиения активности на случайные части: точный рациональный интеграл неизменен.",
             "- Все шесть арифметических примеров наград совпадают со спецификацией.",
             "- Сумма весов Power = 1; CurrentLevel находится между 0 и LifetimeLevel.",
             "- При нулевом входе практики форма за H effective days уменьшается вдвое после опустошения rolling window.",
             "- Coverage: 77 разделов концепции и 32 технических пункта; локальные Markdown-ссылки и JSON drafts проверены.",
             "", "Формулы и ограничения: [Progression Engine](../03-progression-engine.md).", ""]
    return "\n".join(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()
    examples = validate_math()
    if args.write_report:
        (DOCS / "validation/balance-report.md").write_text(report(examples))
    documents, links, source_hash = validate_documents()
    existing_report = DOCS / "validation/balance-report.md"
    if existing_report.exists():
        require(existing_report.read_text() == report(examples), "Balance report stale: rerun --write-report")
    print(f"PASS: {documents} Markdown files; {links} local links; 77 concept sections; 32 technical requirements")
    print("PASS: JSON drafts; strict tool shape; 2002 level thresholds; 250 split cases; XP examples; Form/Power arithmetic")
    print(f"Original concept SHA-256: {source_hash}")
    print("Scope: architecture checks only; no production app or live API tests.")


if __name__ == "__main__":
    main()
