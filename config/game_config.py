""" ==========================================================================
  config/game_config.py —— 遊戲唯一的數值來源（Single Source of Truth）
 ==========================================================================

  這裡只放「數字」與「規則開關」，不放任何流程。
  game_engine.py 每一局開始時會 config_snapshot() 一份深拷貝，
  所以改這裡的數值 → 下一局立刻生效，不用重開伺服器。

  可調的環境變數（測試 / 快速平衡用）
  -----------------------------------
      DEVIL_START_HP=6        DEVIL_MAX_HP=8
      DEVIL_MIN_SHELLS=2      DEVIL_MAX_SHELLS=12
      DEVIL_RELOAD_HEAL=1     DEVIL_MIN_PLAYERS=1   DEVIL_MAX_PLAYERS=4
      DEVIL_TURN_TIMEOUT=60000
      DEVIL_REVEAL_MS=3000    （0 = 關掉開局彈藥提示的裝填鎖）
 ========================================================================== """

from __future__ import annotations

import copy
import os
import random
from typing import Any

from config import items as items_module

VERSION = "1.0.0"
false = False

# ---------------------------------------------------------------------------
#  1. 血量
# ---------------------------------------------------------------------------
HP: dict[str, int] = {
    "START_HP": 5,          # 每局開始的血量
    "START_MAX_HP": 5,      # 每局開始的血量上限（GOLIATH 之類的道具可以往上加）
    "MAX_HP": 5,            # 絕對上限，任何回復都不能超過
}


# ---------------------------------------------------------------------------
#  2. 彈藥 / 裝填
# ---------------------------------------------------------------------------
AMMO: dict[str, Any] = {
    # 每一輪的子彈總數：2 ~ 12（人數多時會再往上加成）
    "MIN_SHELLS": 2,
    "MAX_SHELLS": 12,

    # 人數加成：場上超過 2 人時，人多子彈也多，否則 4 人局一下子就被打光。
    #   總數  += (人數 - 2) * SHELLS_PER_EXTRA_PLAYER      （4 人局每輪多 4 發）
    #   實彈  += floor((人數 - 2) * LIVE_PER_EXTRA_PLAYER) （4 人局多 1 發實彈）
    #   加成後仍會夾在 MIN_SHELLS ~ MAX_SHELLS，並保證至少留 1 發空包彈。
    "SHELLS_PER_EXTRA_PLAYER": 2,
    "LIVE_PER_EXTRA_PLAYER": 0.5,

    # 實彈權重曲線：每輪取一個值，其餘即為空包彈。
    # LIVE_WEIGHT[0] 用於第 1 輪；超出長度就沿用最後一筆。
    #   第1輪 50% 實彈 → 越後面越危險（25%），節奏由「運氣」轉向「算計」。
    "LIVE_WEIGHT": [0.5, 0.4, 0.4, 0.35, 0.35, 0.3, 0.3, 0.3, 0.25, 0.25],

    # 至少各留幾發，避免出現「整輪都實彈」或「整輪都空包」
    "MIN_LIVE": 1,
    "MIN_BLANK": 1,

    # 實彈數量的隨機抖動（±1 發的機率），讓權重只是「期望值」而不是定值
    "LIVE_VARIANCE": 0.25,

    # 每輪總數 = BASE + (round-1)*STEP ± JITTER，最後再夾到 MIN/MAX
    "SHELLS_PER_ROUND_BASE": 2,
    "SHELLS_PER_ROUND_STEP": 1,
    "SHELLS_PER_ROUND_JITTER": 1,

    # 換彈時是否回血（1 = 是）For text
    "HEAL_ON_RELOAD": False,

    # 每輪開始發給每位玩家的道具數
    #   第 1~2 輪 → BASE（2 個）
    #   第 3 輪以後 → ESCALATED（3 個）
    "ITEMS_ON_RELOAD": {
        "BASE": 2,
        "ESCALATE_FROM_ROUND": 3,
        "ESCALATED": 3,
    },

    # 開局 / 每輪的彈藥提示：畫面中央顯示幾毫秒，期間任何人（含 AI）都不能行動
    "AMMO_REVEAL": {
        "ENABLED": True,
        "REVEAL_MS": 3000,
    },
}


# ---------------------------------------------------------------------------
#  3. 規則
# ---------------------------------------------------------------------------
RULES: dict[str, Any] = {
    "MIN_PLAYERS": 1,        # 1 人 = 單人房，會自動補 AI
    "MAX_PLAYERS": 4,
    "HUMAN_ONLY": False,

    # 單人房的 AI 名字（依序取第一個沒人用的）
    "ENEMY_NAMES": ["DeepSeek", "oppo", "denn", "rio"],

    # 回合逾時（毫秒）：太久沒動作 → 伺服器代替你對自己開一槍
    "TURN_TIMEOUT_MS": 25_000,

    "AI": {
        "ENABLED": True,
        "THINK_DELAY_MS": {"min": 1500, "max": 2200},
        # AI 是否「看得到」下一發是什麼。true 會讓 AI 很強，但示範效果好。
        "KNOWS_NEXT_SHELL": True,
    },

    # 純回血道具（香菸 / 急救包…）在滿血時能不能用。
    #   True  = 擋下來，道具不會被吃掉（本專案預設，對玩家友善）
    #   False = 照原版：道具照樣消耗，只是補不到血（純浪費）
    "STRICT_HEAL": False,

    # 每輪重新裝彈後由誰先手。
    #   "first"   = 永遠由第 1 個座位（房主 / 玩家）先手 —— 原版行為
    #   "shooter" = 誰打出最後一發就由誰繼續
    "ROUND_START_TURN": "shooter",
}


# ---------------------------------------------------------------------------
#  4. 上限
# ---------------------------------------------------------------------------
LIMITS: dict[str, Any] = {
    "MAX_ITEMS": 8,               # 道具欄位數（前端顯示 8 格）
    "MAX_ACTIVE_MODIFIERS": 3,    # 同時存在的增益狀態上限
    "BARRAGE_WINDOW_MS": 2000,    # 連發道具的動畫視窗
    # 每個回合最多用幾件道具（0 = 不限制，想用幾個就用幾個）。
    # 注意：道具欄本身上限是 MAX_ITEMS，所以「不限」實際上就是把手上的用完為止。
    "MAX_ITEMS_PER_TURN": 0,

    # 同種道具最多帶幾個（原版規則：香菸最多 2 支，滿了就從獎池裡移除）
    "ITEM_CAPS": {
        "CIGARETTE": 2,
        "CIGARETTES": 1,
    },
}


# ---------------------------------------------------------------------------
#  5. 時間
# ---------------------------------------------------------------------------
TIMING: dict[str, int] = {
    "ROOM_CODE_LENGTH": 4,
    "RECONNECT_GRACE_MS": 15_000,   # 斷線後保留座位的時間
    "GAME_SWITCH_DELAY_MS": 1_400,  # 結算畫面 → 下一局
    "RESULT_REVEAL_DELAY_MS": 900,
    "ACTION_COOLDOWN_MS": 120,      # 同一位玩家兩次操作的間隔，防連點
    "ACTION_DEDUPE_MS": 500,        # 同一位玩家的同類型請求（開槍/用道具）間隔，太近直接忽略
}


# ---------------------------------------------------------------------------
#  6. 前端特效參數（純呈現，不影響規則）
# ---------------------------------------------------------------------------
FX: dict[str, Any] = {
    "SHAKE_MS": 420,
    "SHAKE_INTENSITY": 12,
    "BLOOD_PARTICLES": 22,
    "BLOOD_COLORS": ["#b3000f", "#e01b24", "#5c0006", "#ff5d5d"],
    "SHELL_LIVE_COLOR": "#ff2d55",
    "SHELL_BLANK_COLOR": "#2de2ff",
    "SCREEN_FLASH_ALPHA": 0.45,
    # 中央「本回合裝填」卡片停留時間（前端讀這個值來畫倒數）
    "REVEAL_CARD_MS": 3000,
}


# ---------------------------------------------------------------------------
#  7. DeepSeek 娘（對話 / 立繪）
# ---------------------------------------------------------------------------
DIALOGUE: dict[str, Any] = {
    "ENABLED": True,
    "SPEAKER": "DeepSeek 娘",
    "PORTRAIT": "/assets/deepseek_girl.jpg",
    "BUBBLE_MS": 4600,
    "TYPE_SPEED_MS": 24,
    "COOLDOWN_MS": 900,
    "DEFAULT_CHANCE": 0.55,
    # 每個情境「講不講話」的機率（0 = 不講，1 = 必講）
    "CHANCE": {
        "onGameStart": 1.0,
        "onPlayerShootSelf": 0.6,
        "onPlayerShootDemon": 0.6,
        "onDemonShoot": 0.6,
        "onDemonShootSelf": 0.5,
        "onPlayerBlank": 0.65,
        "onDemonBlank": 0.55,
        "onDemonHurt": 0.75,
        "onPlayerHurt": 0.45,
        "onPlayerDeath": 1.0,
        "onDemonDeath": 1.0,
        "onItemUsed": 0.3,
        "onDemonItem": 0.3,
        "onReload": 0.5,
        "onEmptyGun": 0.5,
        "onIdle": 0.4,
        "onVictory": 1.0,
        "onDefeat": 1.0,
    },
}


# ---------------------------------------------------------------------------
#  8. 環境變數覆寫
# ---------------------------------------------------------------------------
#  key = 環境變數名稱, value = (區塊名稱, 欄位名稱)
#      ("", "欄位")      → 直接改模組層級的 dict
#      ("AMMO", "欄位")  → 改 AMMO 裡的欄位
ENV_OVERRIDES: dict[str, tuple[str, str]] = {
    "DEVIL_START_HP": ("HP", "START_HP"),
    "DEVIL_MAX_HP": ("HP", "MAX_HP"),
    "DEVIL_MIN_SHELLS": ("AMMO", "MIN_SHELLS"),
    "DEVIL_MAX_SHELLS": ("AMMO", "MAX_SHELLS"),
    "DEVIL_RELOAD_HEAL": ("AMMO", "HEAL_ON_RELOAD"),
    "DEVIL_MIN_PLAYERS": ("RULES", "MIN_PLAYERS"),
    "DEVIL_MAX_PLAYERS": ("RULES", "MAX_PLAYERS"),
    "DEVIL_TURN_TIMEOUT": ("RULES", "TURN_TIMEOUT_MS"),
    "DEVIL_REVEAL_MS": ("AMMO_REVEAL", "REVEAL_MS"),
}

APPLIED_ENV_OVERRIDES: list[str] = []


def _section(name: str) -> dict[str, Any]:
    """把 ENV_OVERRIDES 的區塊名稱翻成實際的 dict。"""
    if name == "AMMO_REVEAL":
        return AMMO["AMMO_REVEAL"]
    if name == "HP":
        return HP
    if name == "AMMO":
        return AMMO
    if name == "RULES":
        return RULES
    if name == "LIMITS":
        return LIMITS
    if name == "TIMING":
        return TIMING
    raise KeyError(f"未知的設定區塊：{name}")


def _coerce(old_value: Any, raw: str) -> Any:
    """依原本的型別把字串轉成數字 / 布林，避免整支程式出現字串比對。"""
    if isinstance(old_value, bool):
        return raw.strip().lower() in {"1", "true", "yes", "on", "y"}
    if isinstance(old_value, int):
        return int(float(raw))
    if isinstance(old_value, float):
        return float(raw)
    return raw


def apply_env_overrides() -> list[str]:
    """讀環境變數並就地覆寫設定，回傳實際套用的變數名稱。"""
    APPLIED_ENV_OVERRIDES.clear()
    for env_key, (section_name, field_name) in ENV_OVERRIDES.items():
        raw = os.environ.get(env_key)
        if raw is None or raw == "":
            continue
        target = _section(section_name)
        if field_name not in target:
            continue
        try:
            target[field_name] = _coerce(target[field_name], raw)
            APPLIED_ENV_OVERRIDES.append(f"{env_key}={raw}")
        except (TypeError, ValueError):
            continue
    return list(APPLIED_ENV_OVERRIDES)


# ---------------------------------------------------------------------------
#  9. 查詢用的輔助函式
# ---------------------------------------------------------------------------
def get_live_weight(round_number: int) -> float:
    """第 N 輪的實彈期望比例（夾在 0.01 ~ 0.99，避免全實彈或全空包）。"""
    weights = AMMO["LIVE_WEIGHT"]
    index = max(0, min(len(weights) - 1, int(round_number) - 1))
    return max(0.01, min(0.99, float(weights[index])))


def item_grant_count(round_number: int) -> int:
    """每一輪發幾個道具：第 1~2 輪 2 個，第 3 輪起 3 個。"""
    spec = AMMO["ITEMS_ON_RELOAD"]
    if "min" in spec and "max" in spec:      # 舊格式相容
        return int(spec["min"])
    if int(round_number) >= int(spec["ESCALATE_FROM_ROUND"]):
        return int(spec["ESCALATED"])
    return int(spec["BASE"])


def max_items() -> int:
    return int(LIMITS["MAX_ITEMS"])


def item_cap(item_id: str) -> int:
    """同一種道具最多能帶幾個；0 = 不限制。"""
    caps = LIMITS.get("ITEM_CAPS") or {}
    try:
        return max(0, int(caps.get(item_id, 0)))
    except (TypeError, ValueError):
        return 0


def max_hp() -> int:
    return int(HP["MAX_HP"])


def start_hp() -> int:
    return int(HP["START_HP"])


def reveal_ms() -> int:
    spec = AMMO["AMMO_REVEAL"]
    if not spec.get("ENABLED", True):
        return 0
    return max(0, int(spec.get("REVEAL_MS", 0)))


# ---------------------------------------------------------------------------
#  10. 給前端的設定（一定不含任何會洩題的東西）
# ---------------------------------------------------------------------------
def get_client_config() -> dict[str, Any]:
    items_public = items_module.public_items()
    return {
        "version": VERSION,
        "HP": {
            "START_HP": HP["START_HP"],
            "MAX_HP": HP["MAX_HP"],
            "START_MAX_HP": HP["START_MAX_HP"],
        },
        "AMMO": {
            "MIN_SHELLS": AMMO["MIN_SHELLS"],
            "MAX_SHELLS": AMMO["MAX_SHELLS"],
            "MIN_LIVE": AMMO["MIN_LIVE"],
            "MIN_BLANK": AMMO["MIN_BLANK"],
            "HEAL_ON_RELOAD": bool(AMMO["HEAL_ON_RELOAD"]),
            "ITEMS_ON_RELOAD": copy.deepcopy(AMMO["ITEMS_ON_RELOAD"]),
            "AMMO_REVEAL": copy.deepcopy(AMMO["AMMO_REVEAL"]),
            # 注意：不送 LIVE_WEIGHT（曲線是伺服器的節奏設計，不是玩家該知道的）
        },
        "RULES": {
            "MIN_PLAYERS": RULES["MIN_PLAYERS"],
            "MAX_PLAYERS": RULES["MAX_PLAYERS"],
            "HUMAN_ONLY": bool(RULES["HUMAN_ONLY"]),
            "ENEMY_NAMES": list(RULES["ENEMY_NAMES"]),
            "TURN_TIMEOUT_MS": RULES["TURN_TIMEOUT_MS"],
            "AI": {
                "ENABLED": bool(RULES["AI"]["ENABLED"]),
                # 不送 KNOWS_NEXT_SHELL：那等於告訴玩家「AI 是不是在作弊」
            },
        },
        "LIMITS": dict(LIMITS),
        "TIMING": dict(TIMING),
        "FX": dict(FX),
        "ITEMS": items_public,          # 道具圖鑑（含描述與圖示）
        "DIALOGUE": {
            "ENABLED": bool(DIALOGUE["ENABLED"]),
            "SPEAKER": DIALOGUE["SPEAKER"],
            "PORTRAIT": DIALOGUE["PORTRAIT"],
            "BUBBLE_MS": DIALOGUE["BUBBLE_MS"],
            "TYPE_SPEED_MS": DIALOGUE["TYPE_SPEED_MS"],
            # 不送 CHANCE / COOLDOWN_MS：那是伺服器的說話節奏
        },
    }


def config_snapshot() -> dict[str, Any]:
    """開局時給引擎的完整快照（含內部欄位），引擎只認這一份。"""
    return {
        "version": VERSION,
        "HP": copy.deepcopy(HP),
        "AMMO": copy.deepcopy(AMMO),
        "RULES": copy.deepcopy(RULES),
        "LIMITS": copy.deepcopy(LIMITS),
        "TIMING": copy.deepcopy(TIMING),
        "FX": copy.deepcopy(FX),
        "DIALOGUE": copy.deepcopy(DIALOGUE),
        "ITEMS": copy.deepcopy(items_module.ITEMS),
        "LOOT": copy.deepcopy(items_module.LOOT),
    }


def update_config(patch: dict[str, Any]) -> None:
    """（給測試/開發用）就地覆寫部分設定，只改最上層的區塊。"""
    for section_name, values in (patch or {}).items():
        target = _section(section_name)
        if isinstance(values, dict):
            target.update(values)


# 匯入時就套用一次環境變數
apply_env_overrides()
