"""Pre-demo sanity check: warn about any number still marked as an estimate.

Run before walking on stage:

    python scripts/check_config.py

Exits 0 always (this is a warning tool, not a build gate) but prints a clear
list of every config.PROVENANCE entry that is not yet a confirmed "source" —
so nobody presents an unconfirmed demo number as a verified fact by accident.
"""

import sys
from pathlib import Path

# Windows consoles often default stdout to a legacy codepage (cp1251/cp866)
# that can't encode Cyrillic + emoji together — force UTF-8 so this script
# never crashes on the exact text it's printing.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import config  # noqa: E402


def main() -> int:
    unresolved = [
        (key, prov) for key, prov in config.PROVENANCE.items() if prov.kind != "source"
    ]

    print(f"Проверено констант: {len(config.PROVENANCE)}")
    if not unresolved:
        print("Все константы имеют подтверждённый источник (source). Можно выходить на защиту.")
        return 0

    print(f"\n⚠ Не подтверждено ({len(unresolved)}) — перед защитой стоит перепроверить:\n")
    for key, prov in unresolved:
        value = "не задано" if prov.value is None else prov.value
        print(f"  [{prov.kind}] {key} = {value}")
        print(f"      {prov.note}\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
