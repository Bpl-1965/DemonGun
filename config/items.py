""" ==========================================================================
  config/items.py —— 道具設定（資料驅動的唯一來源）
 ==========================================================================
  這裡只放「資料」，不含任何效果實作。實作在 logic/game_engine.py 的
  _apply_item() 裡，用 effect 欄位當分派鍵（dispatch key）：

      effect          →  _apply_item() 裡的一個 case

  params 語意
  ----------
    HP / MIN / MAX / CHANCE / DAMAGE / SHOTS / COUNT / SKIPS / DURATION_MS
      都是給「說明文字」填空與「效果計算」共用的參數，兩邊都從同一份資料讀，
      所以改這裡的數字，前端說明與後端效果會同步改變。

  keeps_turn
  ----------
    True  = 用完這件道具，回合仍然在自己身上（可以接著開槍或再用道具）。
    False = 用完就交棒給下一位（連發類、搶回合類）。

  想新增道具：加一筆 dict 進 ITEMS、在 LOOT 的 WEIGHTS 給個權重，
  再到 game_engine._apply_item() 補一個 effect 分支即可（前端不用動）。
  刪除道具時記得同時把 LOOT 的 WEIGHTS 那一行拿掉 ——
  跑 validate_loot() 就會告訴你有沒有漏。
 ========================================================================== """

from __future__ import annotations

import copy
import re
from typing import Any

# ---------------------------------------------------------------------------
#  道具表
# ---------------------------------------------------------------------------
ITEMS: list[dict[str, Any]] = [
    {
        "id": "CIGARETTE", "name": "香菸", "icon": "🚬",
        "desc": "回復 {HP} 點生命。",
        "effect": "heal", "params": {"HP": 1}, "keeps_turn": True,
    },
    {
        "id": "CIGARETTES", "name": "整包菸", "icon": "🧊",
        "desc": "回復 {MIN}～{MAX} 點生命。",
        "effect": "heal", "params": {"MIN": 1, "MAX": 3}, "keeps_turn": True,
    },
    {
        "id": "PILLS", "name": "興奮劑", "icon": "💉",
        "desc": "{CHANCE}% 機率回復 {MIN}～{MAX} 點生命。",
        "effect": "random_heal", "params": {"CHANCE": 50, "MIN": 1, "MAX": 4},
        "keeps_turn": True,
    },
    {
        "id": "HANDSAW", "name": "手鋸", "icon": "🪚",
        "desc": "鋸短槍管：下一次開槍造成 {DAMAGE} 傷害。",
        "effect": "cut_barrel", "params": {"DAMAGE": 2, "DURATION_TURNS": 1},
        "keeps_turn": True,
    },
    {
        "id": "MANGLER", "name": "萬能工具", "icon": "🔧",
        "desc": "公開接下來 {COUNT} 發子彈，但會受到 {DAMAGE} 點傷害。",
        "effect": "peek_and_hurt",
        "params": {"COUNT": 3, "DAMAGE": 1},
        "keeps_turn": True,
    },
    {
        "id": "BEER", "name": "啤酒", "icon": "🍺",
        "desc": "退出當前這發子彈並公開它是實彈還是空包彈。",
        "effect": "eject_and_shoot", "params": {}, "keeps_turn": False,
    },
    {
        "id": "BEER2", "name": "烈酒", "icon": "🥃",
        "desc": "連續發射 {SHOTS} 發子彈（每發照常結算）。",
        "effect": "rapid_fire", "params": {"SHOTS": 2}, "keeps_turn": False,
    },
    {
        "id": "HANDCUFFS", "name": "手銬", "icon": "⛓️",
        "desc": "銬住對手：對手下一回合被跳過。",
        "effect": "skip_next", "params": {"SKIPS": 1}, "keeps_turn": True,
    },
    {
        "id": "NAILGROUP", "name": "釘槍", "icon": "🔫",
        "desc": "負荷最重：之後 {SHOTS} 發子彈都造成 {DAMAGE} 傷害。",
        "effect": "nail_gun", "params": {"SHOTS": 3, "DAMAGE": 2}, "keeps_turn": True,
    },
    {
        "id": "INVERTER", "name": "逆轉器", "icon": "🔄",
        "desc": "反轉現在這發子彈（實↔空）；換輪時失效。",
        "effect": "invert", "params": {}, "keeps_turn": True,
    },
    {
        "id": "BUNCH", "name": "驚喜包", "icon": "🎁",
        "desc": "隨機抽 {SHOTS} 個道具。",
        "effect": "gacha", "params": {"SHOTS": 3}, "keeps_turn": True,
    },
    {
        "id": "VISION", "name": "預言鏡", "icon": "👁️",
        "desc": "預知下一輪前 {COUNT} 發子彈的順序（僅你自己看得到）。",
        "effect": "memory", "params": {"COUNT": 4}, "keeps_turn": True,
    },
]

# ---------------------------------------------------------------------------
#  掉落表
# ---------------------------------------------------------------------------
#  mode: "weights" 依 WEIGHTS 權重抽；"uniform" 每件等機率；"none" 不發
#  ⚠ 這裡的每一把鑰匙都必須是 ITEMS 裡真的存在的 id，否則是死權重。
LOOT: dict[str, Any] = {
    "DEFAULT": {
        "mode": "weights",
        "WEIGHTS": {
            "CIGARETTE": 10, "CIGARETTES": 7, "PILLS": 5,
            "HANDSAW": 8, "MANGLER": 7, "BEER": 9, "BEER2": 5,
            "HANDCUFFS": 6, "NAILGROUP": 3, "INVERTER": 7,
            "BUNCH": 4, "VISION": 3,
        },
        "EXCLUDE": [],
    },
    # 給「玩家方」的掉落表；None = 沿用 DEFAULT
    "PLAYER": None,
    # 給「敵方」的掉落表；None = 沿用 DEFAULT
    "ENEMY": None,
}

ITEM_BY_ID: dict[str, dict[str, Any]] = {item["id"]: item for item in ITEMS}

_PLACEHOLDER = re.compile(r"\{([A-Z_]+)\}")


# ---------------------------------------------------------------------------
#  工具函式
# ---------------------------------------------------------------------------
def get_item(item_id: str) -> dict[str, Any] | None:
    """依 id 取道具定義；找不到回 None。"""
    return ITEM_BY_ID.get(item_id)


def describe_item(item: dict[str, Any]) -> str:
    """把 desc 裡的 {HP} / {CHANCE} 之類的佔位符用 params 填掉。"""
    params = item.get("params") or {}
    return _PLACEHOLDER.sub(
        lambda m: str(params[m.group(1)]) if m.group(1) in params else m.group(0),
        str(item.get("desc", "")),
    )


def public_items() -> list[dict[str, Any]]:
    """要送給前端的道具資料（只含公開欄位，不含任何伺服器機密）。"""
    return [
        {
            "id": item["id"],
            "name": item["name"],
            "icon": item.get("icon") or "❓",
            "desc": describe_item(item),
            "effect": item["effect"],
            "params": copy.deepcopy(item.get("params") or {}),
        }
        for item in ITEMS
    ]


def loot_table(side: str = "PLAYER") -> dict[str, Any]:
    """取得某一方的掉落表（沒設定就回 DEFAULT）。"""
    table = LOOT.get(side) or LOOT["DEFAULT"]
    return table


def roll_loot(rng, side: str = "PLAYER", exclude: list[str] | None = None) -> str | None:
    """依掉落表抽一個道具 id（純資料操作，不做庫存檢查）。"""
    table = loot_table(side)
    excluded = set(table.get("EXCLUDE") or [])
    if exclude:
        excluded.update(exclude)

    mode = table.get("mode", "weights")
    if mode == "none":
        return None

    candidates = [item["id"] for item in ITEMS if item["id"] not in excluded]
    if not candidates:
        return None

    if mode == "uniform":
        return rng.choice(candidates)

    weights = table.get("WEIGHTS") or {}
    pool = [(cid, float(weights.get(cid, 0))) for cid in candidates]
    pool = [(cid, w) for cid, w in pool if w > 0]
    if not pool:
        return rng.choice(candidates)

    total = sum(w for _, w in pool)
    roll = rng.random() * total
    upto = 0.0
    for cid, weight in pool:
        upto += weight
        if roll <= upto:
            return cid
    return pool[-1][0]


def validate_loot() -> list[str]:
    """檢查掉落表與道具表是不是對得上（回傳問題清單，空 list = 沒問題）。

    自保機制：WEIGHTS 寫了不存在的 id、或 WEIGHTS 漏了某件道具
    （不是 EXCLUDE 的），都會被列出來，避免「抽不到」或「抽到不存在的道具」。
    """
    problems: list[str] = []
    known = set(ITEM_BY_ID)
    for side in ("DEFAULT", "PLAYER", "ENEMY"):
        table = LOOT.get(side)
        if not table:
            continue
        if table.get("mode") != "weights":
            continue
        weights = table.get("WEIGHTS") or {}
        excluded = set(table.get("EXCLUDE") or [])
        for item_id in weights:
            if item_id not in known:
                problems.append(f"LOOT[{side}] 的 WEIGHTS 有不存在於 ITEMS 的道具：{item_id}")
        for item_id in known - excluded:
            if item_id not in weights:
                problems.append(f"LOOT[{side}] 的 WEIGHTS 漏了道具：{item_id}")
    return problems
