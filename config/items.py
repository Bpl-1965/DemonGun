""" ==========================================================================
  config/items.py —— 道具清單（唯一需要改的檔案）
  ==========================================================================
  【怎麼加一件道具】只要在下面 ITEMS 清單加一筆，然後重開 app.py。

      {
          "id": "MOLOTOV",              # 唯一 id：A-Z / 0-9 / 底線
          "name": "汽油彈",              # 顯示名稱
          "icon": "🔥",                  # 一個 emoji
          "desc": "造成 {DAMAGE} 點傷害。",  # {XXX} 會用 params 同名的值填進去
          "effect": "deal_damage",      # 要做什麼（見下方「可用 effect」）
          "params": {"DAMAGE": 2},      # 給 effect 與 desc 共用的數字
          "keeps_turn": False,          # 用完還是不是自己的回合
      }

  然後到 LOOT 的 CHANCES 給它一個機率（例如 "MOLOTOV": 8），否則永遠抽不到。

  【可用 effect】（實作在 logic/effects.py，重載即生效）
      deal_damage   DAMAGE                        對目標造成傷害
      heal          HP 或 MIN/MAX                 回復生命
      random_heal   CHANCE MIN MAX                機率性回復
      gamble_heal   CHANCE MIN MAX HP             機率回復，失敗扣 HP
      max_hp_up     HP MAX_HP                     扣 HP 換上限
      skip_next     SKIPS                         目標下 N 個回合被跳過
      cut_barrel    （無）                        下一發傷害 +1
      nail_gun      SHOTS DAMAGE                  接下來 N 發固定傷害
      steal_turn    （無）                        搶走回合
      extra_turn    CHANCE                        機率保留回合
      peek / peek_many / memory / memory_all  COUNT   看接下來幾發
      peek_and_hurt COUNT DAMAGE                  看牌但自己也受傷
      eject / eject_and_shoot  （無）             退出當前這發並公開
      eject_random  MIN MAX                       隨機退出幾發
      invert        （無）                        反轉當前這發
      rapid_fire    SHOTS                         連射 N 發
      gacha         SHOTS                         隨機獲得 N 件道具


    1. 傷害與攻擊類

    • "effect": "deal_damage"：{"DAMAGE": 2}（直接對對手造成幾點傷害）
    • "effect": "cut_barrel"：{"DAMAGE": 1}（下一發傷害增加幾點）
    • "effect": "nail_gun"：{"SHOTS": 3, "DAMAGE": 2}（接下來 SHOTS 發子彈都固定造成 DAMAGE 點傷害）
    • "effect": "rapid_fire"：{"SHOTS": 2}（連續射擊幾發）

    2. 治療與血量類

    • "effect": "heal"：{"HP": 1} 或 {"MIN": 1, "MAX": 3}（固定回血，或隨機回 MIN～MAX 血）
    • "effect": "random_heal"：{"CHANCE": 50, "MIN": 1, "MAX": 4}（有 CHANCE% 機率回 MIN～MAX 血）
    • "effect": "gamble_heal"：{"CHANCE": 50, "MIN": 2, "MAX": 3, "HP": 1}（成功回 MIN～MAX 血，失敗反扣 HP 血）
    • "effect": "max_hp_up"：{"HP": 1, "MAX_HP": 1}（扣 HP 點當前血量，換取 MAX_HP 點最大血量上限）

    3. 看彈與退彈類

    • "effect": "peek" / "peek_many" / "memory" / "memory_all"：{"COUNT": 2}（偷看或預知接下來幾發子彈）
    • "effect": "peek_and_hurt"：{"COUNT": 2, "DAMAGE": 1}（偷看 COUNT 發子彈，但自己扣 DAMAGE 血）
    • "effect": "eject_random"：{"MIN": 1, "MAX": 2}（隨機退出 MIN～MAX 發子彈）
    • "effect": "eject" / "invert"：{}（留空即可，不需參數）

    4. 回合控制與道具類

    • "effect": "skip_next"：{"SKIPS": 1}（讓對手跳過接下來幾回合）
    • "effect": "extra_turn"：{"CHANCE": 50}（有 CHANCE% 機率額外獲得回合）
    • "effect": "gacha"：{"SHOTS": 2}（隨機抽幾件新道具）
    • "effect": "steal_turn"：{}（留空即可，不需參數）

    5. 通用額外參數（任何道具都能加）

    • "CHANCE"：加在任何道具的 params 裡都能變成機率道具，支援數字 60、小數 0.6 或分數 "1/2"（例如 {"DAMAGE": 3, "CHANCE": 50} 就是 50% 機率打 3 滴血）。
    • {參數名} 自動替換：只要在 "desc" 寫 {DAMAGE}、{COUNT}、{CHANCE}，遊戲就會自動把 params 裡的數字填進說明文字。


  【檢查】重開 app.py 時會自動檢查清單（缺欄位、id 重複、effect 沒實作、
  desc 用到不存在的 params、抽不到的孤兒道具），有問題會直接印在啟動訊息，
  也會出現在 /api/health 的 itemProblems 欄位。
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
        "desc": "回復 {HP} 點生命",
        "effect": "heal", "params": {"HP": 1}, "keeps_turn": True,
    },
    {
        "id": "CIGARETTES", "name": "整包菸", "icon": "🧊",
        "desc": "回復 {MIN}～{MAX} 點生命。",
        "effect": "heal", "params": {"MIN": 1, "MAX": 2}, "keeps_turn": True,
    },
    {
        "id": "PILLS", "name": "興奮劑", "icon": "💉",
        "desc": "有 {CHANCE}% 機率獲得 {SHOTS} 個道具，並讓下一次射擊造成 {DAMAGE} 點傷害。",
        "effect": "gacha_cut_barrel", "params": {"CHANCE": 40, "SHOTS": 1, "DAMAGE": 2},
        "keeps_turn": True,
    },
    {
        "id": "HANDSAW", "name": "手鋸", "icon": "🪚",
        "desc": "鋸短槍管：下一發傷害 +{DAMAGE}。",
        "effect": "cut_barrel", "params": {"DAMAGE": 1, "DURATION_TURNS": 1},
        "keeps_turn": True,
    },
    {
        "id": "MANGLER", "name": "萬能", "icon": "🔧",
        "desc": "公開接下來 {COUNT} 發子彈，但會受到 {DAMAGE} 點傷害。",
        "effect": "peek_and_hurt",
        "params": {"COUNT": 4, "DAMAGE": 2},
        "keeps_turn": True,
    },
    {
        "id": "BEER", "name": "啤酒", "icon": "🍺",
        "desc": "退出當前這發子彈並公開它是實彈還是空包彈。",
        "effect": "eject_and_shoot", "params": {}, "keeps_turn": True,
    },
    {
        "id": "BEER2", "name": "烈酒", "icon": "🥃",
        "desc": "連續發射 {SHOTS} 發子彈（每發照常結算）。",
        "effect": "rapid_fire", "params": {"SHOTS": 2}, "keeps_turn": True,
    },
    {
        "id": "NAILGROUP", "name": "釘槍", "icon": "🔫",
        "desc": "負荷最重：之後 {SHOTS} 發子彈都造成 {DAMAGE} 傷害。",
        "effect": "nail_gun", "params": {"SHOTS": 3, "DAMAGE": 2}, "keeps_turn": True,
    },
    {
        "id": "HANDCUFFS", "name": "手銬", "icon": "⛓️",
        "desc": "銬住對手：對手下一回合被跳過。",
        "effect": "skip_next", "params": {"SKIPS": 1}, "keeps_turn": True,
    },
    {
        "id": "INVERTER", "name": "逆轉器", "icon": "🔄",
        "desc": "反轉現在子彈",
        "effect": "invert", "params": {}, "keeps_turn": True,
    },
    {
        "id": "BUNCH", "name": "驚喜包", "icon": "🎁",
        "desc": "隨機抽 {SHOTS} 個道具。",
        "effect": "gacha", "params": {"SHOTS": 2}, "keeps_turn": True,
    },
    {
        "id": "VISION", "name": "預言鏡", "icon": "👁️",
        "desc": "預知下一輪前 {COUNT} 發子彈的順序（僅你自己看得到）。",
        "effect": "memory", "params": {"COUNT": 4}, "keeps_turn": True,
    },

    # ── 機率寫在道具自己的 params 裡：改這裡的 CHANCE 就改這件道具的命中率 ──
    {
        "id": "MOLOTOV", "name": "汽油彈", "icon": "🔥",
        "desc": "{CHANCE}% 機率造成 {DAMAGE} 點傷害。", 
        "effect": "deal_damage", "params": {"CHANCE": 20, "DAMAGE": 2},
        "keeps_turn": True,
    },
    {
        "id": "LUCKY_CIG", "name": "幸運菸", "icon": "🍀",
        "desc": "{CHANCE}% 機率回復 {HP} 點生命。",
        "effect": "heal", "params": {"CHANCE": "20", "HP": 5},
        "keeps_turn": True,
    },
    {
        "id": "OMEGA_MIX", "name": "終局混合物", "icon": "☠️",
        "desc": "有 {CHANCE}% 機率依序回血 {HP} 點、提升 {MAX_HP} 點血量上限、預知 {COUNT} 發子彈、啟動釘槍、銬住對手、抽取 {SHOTS} 個道具並造成 {DAMAGE} 點傷害。",
        "effect": "heal_max_hp_up_peek_cut_barrel_nail_gun_skip_next_gacha_deal_damage",
        "params": {"CHANCE": 10, "HP": 1, "MAX_HP": 1, "COUNT": 4, "DAMAGE": 2, "SHOTS": 1, "SKIPS": 1},
        "keeps_turn": True,
    },
]

# ---------------------------------------------------------------------------
#  掉落表
# ---------------------------------------------------------------------------
#  mode: "percent" 依 CHANCES 百分比抽；"uniform" 每件等機率；"none" 不發
#  ⚠ 這裡的每一把鑰匙都必須是 ITEMS 裡真的存在的 id。
LOOT: dict[str, Any] = {
    "DEFAULT": {
        "mode": "percent",
        # 總和請維持 ≤ 100（重開 app.py 會自動檢查）。
        "CHANCES": {
            "CIGARETTE": 10, "CIGARETTES": 8, "PILLS": 7,
            "HANDSAW": 7, "MANGLER": 6, "BEER": 9, "BEER2": 5,
            "HANDCUFFS": 7, "NAILGROUP": 5, "INVERTER": 7,
            "BUNCH": 9, "VISION": 7, "MOLOTOV": 6, "LUCKY_CIG": 6,
            "OMEGA_MIX": 1,
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


def rebuild_index() -> dict[str, dict[str, Any]]:
    """重建 id → 道具 的索引。

    新增 / 刪除道具後呼叫一次即可（重載伺服器時會自動跑）。
    注意舊字典是原地更新，其他人既有的參考不會失效。
    """
    ITEM_BY_ID.clear()
    for item in ITEMS:
        if isinstance(item, dict) and item.get("id"):
            ITEM_BY_ID[str(item["id"])] = item
    return ITEM_BY_ID


# ---------------------------------------------------------------------------
#  工具函式
# ---------------------------------------------------------------------------
def get_item(item_id: str) -> dict[str, Any] | None:
    """依 id 取道具定義；找不到回 None。

    索引過期（例如程式內直接 append 到 ITEMS）時會自動重建一次再查，
    這樣「加一件道具」永遠不會因為忘了同步索引而失效。
    """
    item = ITEM_BY_ID.get(item_id)
    if item is not None:
        return item
    if len(ITEM_BY_ID) != len(ITEMS):
        rebuild_index()
        return ITEM_BY_ID.get(item_id)
    return None


def describe_item(item: dict[str, Any]) -> str:
    """把 desc 裡的 {HP} / {CHANCE} 之類的佔位符用 params 填掉。

    {CHANCE} 特別處理：寫 75 / 0.75 / "1/4" 都會顯示成人看得懂的百分比，
    所以改 params 的機率，前端說明文字會自己跟著變。
    """
    params = item.get("params") or {}

    def fill(m: re.Match) -> str:
        key = m.group(1)
        if key == "CHANCE":
            from logic.effects import chance_of

            pct = chance_of(params) * 100.0
            return str(int(pct)) if abs(pct - round(pct)) < 0.01 else f"{pct:.1f}"
        return str(params[key]) if key in params else m.group(0)

    return _PLACEHOLDER.sub(fill, str(item.get("desc", "")))


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

    if mode == "percent":
        chances = table.get("CHANCES") or {}
        configured_total = sum(float(chance) for chance in chances.values())
        remaining = max(0.0, 100.0 - configured_total)
        unassigned = [cid for cid in candidates if cid not in chances]
        if not unassigned:
            unassigned = candidates
        fallback_chance = remaining / len(unassigned) if unassigned else 0.0
        pool = [
            (
                cid,
                float(chances.get(cid, 0))
                + (fallback_chance if cid in unassigned else 0.0),
            )
            for cid in candidates
        ]
    else:
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

    自保機制：未知 id、超過 100% 的 CHANCES，以及 WEIGHTS 漏列道具
    都會被列出來，避免「抽不到」或「抽到不存在的道具」。
    """
    problems: list[str] = []
    known = set(ITEM_BY_ID)
    for side in ("DEFAULT", "PLAYER", "ENEMY"):
        table = LOOT.get(side)
        if not table:
            continue
        mode = table.get("mode", "weights")
        if mode not in ("weights", "percent"):
            continue
        weights_key = "CHANCES" if mode == "percent" else "WEIGHTS"
        weights = table.get(weights_key) or {}
        excluded = set(table.get("EXCLUDE") or [])
        for item_id in weights:
            if item_id not in known:
                problems.append(f"LOOT[{side}] 的 {weights_key} 有不存在於 ITEMS 的道具：{item_id}")
        for item_id in known - excluded:
            if mode == "weights" and item_id not in weights:
                problems.append(f"LOOT[{side}] 的 {weights_key} 漏了道具：{item_id}")
        if mode == "percent" and sum(float(chance) for chance in weights.values()) > 100:
            problems.append(f"LOOT[{side}] 的 CHANCES 總和超過 100%")
    return problems


def validate_items() -> list[str]:
    """檢查道具清單本身（重載時自動跑；有問題就在啟動訊息與 /api/health 顯示）。

    檢查項目：
      · 必填欄位：id / name / effect
      · id 不可重複，且只能是 A-Z 0-9 底線（前端與封包都靠這個）
      · desc 的 {佔位符} 必須在 params 裡找得到，否則玩家會看到 "{HP}" 這種殘字
      · effect 必須有對應的實作（logic/effects.py 有註冊）
      · 沒寫在 LOOT CHANCES 裡的道具 → 警告（抽不到）
    """
    problems: list[str] = []
    seen: set[str] = set()

    for index, item in enumerate(ITEMS):
        if not isinstance(item, dict):
            problems.append(f"ITEMS[{index}] 不是 dict")
            continue
        item_id = str(item.get("id") or "")
        label = item_id or f"ITEMS[{index}]"
        for field in ("id", "name", "effect"):
            if not str(item.get(field) or "").strip():
                problems.append(f"{label} 缺少必填欄位 {field}")
        if item_id:
            if not re.fullmatch(r"[A-Z0-9_]+", item_id):
                problems.append(f"{label} 的 id 只能用 A-Z、0-9、底線")
            if item_id in seen:
                problems.append(f"{label} 的 id 重複（每個道具的 id 必須唯一）")
            seen.add(item_id)
        placeholders = set(_PLACEHOLDER.findall(str(item.get("desc") or "")))
        missing = sorted(ph for ph in placeholders if ph not in (item.get("params") or {}))
        if missing:
            problems.append(f"{label} 的 desc 用到了 params 沒有的欄位：{', '.join(missing)}")

    # effect 是否有實作（延後匯入，避免 config → logic 的循環）
    try:
        from logic.effects import EFFECTS

        for item in ITEMS:
            if not isinstance(item, dict):
                continue
            effect = item.get("effect")
            if effect and effect not in EFFECTS:
                problems.append(f"{item.get('id')} 的 effect「{effect}」沒有實作（logic/effects.py 沒有註冊）")
    except ImportError:  # pragma: no cover - 獨立檢查時可能還沒建好
        pass

    # 抽不到的道具（只是警告，不影響啟動）
    chances = ((LOOT.get("DEFAULT") or {}).get("CHANCES") or {})
    for item in ITEMS:
        if isinstance(item, dict) and item.get("id") and item["id"] not in chances:
            problems.append(f"{item['id']} 不在 LOOT 的 CHANCES 裡，永遠抽不到（要就加上機率，或列入 EXCLUDE）")

    return problems
