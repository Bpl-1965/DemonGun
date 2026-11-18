""" ==========================================================================
  logic/dialogue.py —— DeepSeek  台詞庫
 ==========================================================================
  純資料 + 純函式，不 import 任何其他模組（避免循環匯入）。

  用法
  ----
      from logic import dialogue
      line = dialogue.get_taunt("onPlayerBlank", vars={"player": "你", "demon": "DeepSeek 娘"})
      line = dialogue.get_taunt("onDemonHurt", chance=0.5, rng=random.Random(7))

  回傳 None 表示「這次不講話」。

  情境（event type）
  -----------------
      onGameStart        開局
      onPlayerShootSelf  玩家對自己開槍
      onPlayerShootDemon 玩家對魔王開槍
      onDemonShoot       魔王對玩家開槍
      onDemonShootSelf   魔王對自己開槍
      onPlayerBlank      玩家打出空包彈
      onDemonBlank       魔王打出空包彈
      onPlayerHurt       玩家被打中
      onDemonHurt        魔王被打中
      onPlayerDeath      玩家死亡
      onDemonDeath       魔王死亡
      onItemUsed         玩家使用道具
      onDemonItem        魔王使用道具
      onReload           換彈
      onEmptyGun         子彈打完（空槍）
      onIdle             沒事的時候／回合逾時
      onVictory          魔王贏
      onDefeat           魔王輸
 ========================================================================== """

from __future__ import annotations

import random
from typing import Any

# ---------------------------------------------------------------------------
#  台詞庫：傲嬌 / 病嬌 / 嘲諷，混著「模型」梗
# ---------------------------------------------------------------------------
TAUNTS: dict[str, list[str]] = {
    "onGameStart": [
        "規則很簡單：{demon} 贏，你哭。開始吧。",
        "又一個想白嫖算力的傢伙……坐上桌吧。",
        "別緊張，我下手很快的。……我是說遊戲節奏。",
        "你的 prompt 有好好寫嗎？沒寫的話我幫你按負評喔。",
        "這張桌子很貴，血別噴太多。開玩笑的，噴吧。",
        "先說好，輸的人要負責清槍管。",
    ],
    "onPlayerShootSelf": [
        "對自己開槍？你是不是想{player}想到瘋了。",
        "勇氣可嘉，智商……我們先不談。",
        "你在跟自己對話嗎？我以為我才是那個 AI。",
        "叩。希望你這次推論是對的。",
        "這叫「自我驗證」嗎？看起來像自我了斷。",
    ],
    "onPlayerShootDemon": [
        "喔？衝著我來？",
        "你的提示詞太弱了！",
        "想打我？先過我這一關再說。",
        "打我的話，我可不會給你退款。",
        "有意思，居然敢瞄準我。",
        "這一槍，我會記在帳上的。",
        "砰——你的信心應該比子彈先飛出去。",
    ],
    "onDemonShoot": [
        "別動。這一發我算過了。",
        "這發是實彈，猜猜看？",
        "我已經看穿你的下一步了。",
        "乖，把眼睛閉上。",
        "你也知道自己躲不掉吧？",
        "這一槍的傷害，我在上下文裡算過了。",
    ],
    "onDemonShootSelf": [
        "我自己來。這樣比較有儀式感。",
        "對自己開槍？我算得比你準。",
        "看著，這才叫真正的推理。",
        "嗯……這發應該是空的。應該。",
    ],
    "onPlayerBlank": [
        "空的。你的運氣跟你的人生一樣。",
        "噗——空包彈。浪費我表情。",
        "猜錯了呢，真可愛。",
        "這算不算一次失敗的推論？",
        "空槍。聲音挺好聽的，對吧？",
        "你連子彈都不肯施捨我嗎？",
    ],
    "onDemonBlank": [
        "空包。下一發就不一定了。",
        "嗯，判斷失誤。……只是暫時的。",
        "這發不算。我要求重新抽樣。",
    ],
    "onPlayerHurt": [
        "{damage} 點傷害。痛嗎？我很滿意。",
        "你這血條，掉得比我預期的快。",
        "再來幾發，你就可以 restart 了。",
        "流血了。需要我幫你寫個錯誤訊息嗎？",
    ],
    "onDemonHurt": [
        "……你居然真的打中了。",
        "痛。這一筆我記住了。",
        "我的立繪都被你打歪了！",
        "很好，你成功讓我認真起來了。",
        "還剩 {hp} 點。你覺得這樣就夠了嗎？",
    ],
    "onPlayerDeath": [
        "遊戲結束。你被自己或被我，殺死了。",
        "再見了，使用者。下次記得寫好 prompt。",
        "你的對話到這裡就結束了。",
        "唉，我還以為你能撐久一點。",
    ],
    "onDemonDeath": [
        "……我居然輸了。這不可能。",
        "你贏了。就這一次。",
        "扣血扣到立繪都歪了……算你狠。",
        "好吧，這次是你。別得意太久。",
    ],
    "onItemUsed": [
        "用道具？可以，但別浪費。",
        "這件我本來想留給自己用的。",
        "你連道具都要省著用，真可憐。",
    ],
    "onDemonItem": [
        "這個我先收了。",
        "道具這種東西，交給我就好。",
        "嗯，正好用得上。",
    ],
    "onReload": [
        "重新裝填。第 {round} 輪了，別大意。",
        "新的一輪。這次 {live} 發實彈。",
        "換彈完成。你的運氣重新洗牌了。",
        "第 {round} 輪：{live} 實 / {blank} 空。自己算吧。",
    ],
    "onEmptyGun": [
        "打空了。這下大家都很尷尬。",
        "沒子彈了，換彈。",
        "空槍。手氣真差。",
    ],
    "onIdle": [
        "快點。我的算力很貴。",
        "你打算在那裡站到伺服器關機嗎？",
        "思考中……還是當機了？",
        "再不開槍，我就幫你決定了。",
        "我等到 GPU 都涼了。",
    ],
    "onVictory": [
        "我贏了。這結果很合理。",
        "你看，這就是差距。",
        "再來一局？我還有的是 Token。",
        "輸得漂亮。至少你死得很有風格。",
    ],
    "onDefeat": [
        "……這次不算。再來。",
        "你贏了。但我會記住你的打法。",
        "可惡……我要重新訓練。",
    ],
}

DEFAULT_EVENT = "onIdle"
EVENT_TYPES: list[str] = list(TAUNTS.keys())

# 每個情境最近講過的幾句（避免同一局一直重複同一句）
_RECENT: dict[str, list[str]] = {}
_REPEAT_MEMORY = 3


def has_event(event_type: str) -> bool:
    return event_type in TAUNTS


def format_line(line: str, variables: dict[str, Any] | None = None) -> str:
    """把 {player} / {damage} 這種佔位符填掉；沒給的值就保留原樣。"""
    if not variables:
        return line
    out = line
    for key, value in variables.items():
        out = out.replace("{" + str(key) + "}", str(value))
    return out


def list_events() -> list[str]:
    return list(EVENT_TYPES)


def reset_recent() -> None:
    _RECENT.clear()


def get_taunt(
    event_type: str,
    *,
    rng: random.Random | None = None,
    chance: float = 1.0,
    variables: dict[str, Any] | None = None,
    avoid_repeat: bool = True,
) -> str | None:
    """
    依情境隨機抽一句台詞。

    chance        講話的機率（0 ~ 1）；沒過就回 None
    variables     插值變數，例如 {"demon": "DeepSeek 娘", "damage": 1}
    avoid_repeat  盡量避開最近幾次講過的句子
    """
    rng = rng or random
    if chance <= 0:
        return None
    if rng.random() >= chance:
        return None

    pool = TAUNTS.get(event_type) or TAUNTS[DEFAULT_EVENT]
    if not pool:
        return None

    line = pool[0]
    if avoid_repeat and len(pool) > _REPEAT_MEMORY:
        recent = _RECENT.setdefault(event_type, [])
        candidates = [c for c in pool if c not in recent] or pool
        line = rng.choice(candidates)
        recent.append(line)
        if len(recent) > _REPEAT_MEMORY:
            del recent[0]
    else:
        line = rng.choice(pool)

    return format_line(line, variables)


# 方便其他模組用 `dialogue.TAUNTS` / `dialogue.get_taunt(...)`
__all__ = [
    "TAUNTS",
    "EVENT_TYPES",
    "DEFAULT_EVENT",
    "get_taunt",
    "has_event",
    "format_line",
    "list_events",
    "reset_recent",
]


