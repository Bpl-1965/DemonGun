""" ==========================================================================
  logic/effects.py —— 道具效果註冊表（資料驅動的「動作」端）
  ==========================================================================
  config/items.py 只寫「資料」（id / name / icon / desc / effect / params），
  這裡負責實作「effect 這個名字要做什麼」。

  新增一種效果：
      1. 在下面寫一個函式，簽名固定：
             def my_effect(game, player, target, params, item) -> tuple[list[dict], bool]
             回傳 (要送給前端的動作串, 是否保留回合)
      2. 加 @EFFECTS.register("my_effect")
      3. 在 config/items.py 的道具用 "effect": "my_effect"
      4. 重開伺服器 → 新道具立刻可用（效果、說明文字、掉落表都由資料驅動）

  只要 params 的數字變，效果就跟著變，不用碰引擎。
 ========================================================================== """

from __future__ import annotations

from typing import Any, Callable

from config import items as items_module

# 效果函式： (game, player, target, params, item) -> (actions, keeps_turn)
Handler = Callable[..., "tuple[list[dict[str, Any]], bool]"]

_REGISTRY: dict[str, Handler] = {}


def register(*names: str) -> Callable[[Handler], Handler]:
    """把函式註冊到一個或多個效果名稱上。"""

    def decorator(fn: Handler) -> Handler:
        for name in names:
            _REGISTRY[str(name)] = fn
        return fn

    return decorator


class EffectTable:
    """給引擎用的查詢表（EFFECTS.get("heal") 這種用法）。"""

    def get(self, name: Any) -> Handler | None:
        return _REGISTRY.get(str(name)) if name else None

    def __contains__(self, name: Any) -> bool:
        return str(name) in _REGISTRY

    def names(self) -> list[str]:
        return sorted(_REGISTRY)


EFFECTS = EffectTable()


def _int(params: dict[str, Any], key: str, default: int) -> int:
    try:
        return int(params.get(key, default))
    except (TypeError, ValueError):
        return int(default)


def _float(params: dict[str, Any], key: str, default: float) -> float:
    try:
        return float(params.get(key, default))
    except (TypeError, ValueError):
        return float(default)


# ---------------------------------------------------------------------------
#  機率（寫在道具自己的 params 裡）
# ---------------------------------------------------------------------------
def chance_of(params: dict[str, Any], default: float = 100.0) -> float:
    """解析 params 的機率，回傳 0.0 ~ 1.0。

    支援三種寫法，都放在道具自己的 params 底下：
        "CHANCE": 75          → 75%
        "CHANCE": 0.75        → 75%（小於等於 1 視為比例）
        "CHANCE": "1/4"       → 25%
    沒寫就用 default（預設 100% = 一定生效）。
    """
    raw = params.get("CHANCE", default)
    if isinstance(raw, str) and "/" in raw:
        try:
            num, den = raw.split("/", 1)
            den_f = float(den)
            return 0.0 if den_f == 0 else max(0.0, min(1.0, float(num) / den_f))
        except (TypeError, ValueError):
            return 1.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 1.0
    if value <= 1.0:      # 0.75 → 75%
        return max(0.0, value)
    return max(0.0, min(1.0, value / 100.0))


def roll_chance(game: Any, params: dict[str, Any], default: float = 100.0) -> bool:
    """擲一次機率；用這一局的 rng，所以可重現、也不能被前端影響。"""
    return game.rng.random() < chance_of(params, default)


def _say_chance(params: dict[str, Any]) -> str:
    """給說明文字用的百分比字串（顯示時不會有 0.75 這種怪數字）。"""
    pct = chance_of(params) * 100.0
    return str(int(pct)) if abs(pct - round(pct)) < 0.01 else f"{pct:.1f}"


def _on_intel_shift(game: Any, count: int = 1) -> None:
    """子彈被消耗 / 退出時，所有人的「已知順序」一起往前推。"""
    for p in game.players:
        if p.intel:
            p.intel = p.intel[max(0, count):] if count > 1 else p.intel[1:]


# ---------------------------------------------------------------------------
#  數值類
# ---------------------------------------------------------------------------
@register("deal_damage")
def _deal_damage(game, player, target, params, item):
    actions = []
    dmg = max(0, _int(params, "DAMAGE", 1))
    victim = target or game._default_opponent(player)
    if victim and not victim.dead and dmg:
        victim.hp = max(0, victim.hp - dmg)
        if victim.hp <= 0:
            victim.dead = True
        actions.append(
            {"type": "DAMAGE", "playerId": victim.id, "targetId": victim.id,
             "amount": dmg, "hp": victim.hp, "dead": victim.dead}
        )
        game._log("damage", f"{player.name} 對 {victim.name} 造成了 {dmg} 點傷害。")
    return actions, False


@register("heal")
def _heal(game, player, target, params, item):
    if "HP" in params:
        amount = _int(params, "HP", 1)
    else:
        amount = game.rng.randint(_int(params, "MIN", 1), _int(params, "MAX", 1))
    healed = game._heal(player, amount)
    if healed:
        game._log("heal", f"{player.name} 回復 {healed['amount']} 點生命。")
        return [healed], False
    return [], False


@register("random_heal")
def _random_heal(game, player, target, params, item):
    if not roll_chance(game, params, 50):
        return [{"type": "ITEM_FAILED", "playerId": player.id, "itemId": item["id"], "reason": "no_effect"}], False
    amount = game.rng.randint(_int(params, "MIN", 1), _int(params, "MAX", 1))
    healed = game._heal(player, amount)
    return ([healed] if healed else []), False


@register("gamble_heal")
def _gamble_heal(game, player, target, params, item):
    if roll_chance(game, params, 50):
        amount = game.rng.randint(_int(params, "MIN", 1), _int(params, "MAX", 1))
        healed = game._heal(player, amount)
        return ([healed] if healed else []), False
    dmg = max(0, _int(params, "HP", 1))
    player.hp = max(0, player.hp - dmg)
    if player.hp <= 0:
        player.dead = True
    return [
        {"type": "DAMAGE", "playerId": player.id, "targetId": player.id,
         "amount": dmg, "hp": player.hp, "dead": player.dead}
    ], False


@register("max_hp_up")
def _max_hp_up(game, player, target, params, item):
    cost = max(0, _int(params, "HP", 1))
    gain = max(0, _int(params, "MAX_HP", 1))
    limit = int((game.config.get("HP") or {}).get("MAX_HP", player.max_hp))
    player.hp = max(1, player.hp - cost)
    player.max_hp = min(limit, player.max_hp + gain)
    return [
        {"type": "MODIFIER", "playerId": player.id, "kind": "max_hp", "hp": player.hp, "maxHp": player.max_hp}
    ], False


# ---------------------------------------------------------------------------
#  狀態 / 回合控制類
# ---------------------------------------------------------------------------
@register("skip_next")
def _skip_next(game, player, target, params, item):
    victim = target or game._default_opponent(player)
    if victim is None:
        return [], False
    victim.skips += max(1, _int(params, "SKIPS", 1))
    return [
        {"type": "MODIFIER", "playerId": player.id, "targetId": victim.id,
         "kind": "cuffed", "skips": victim.skips}
    ], False


@register("cut_barrel")
def _cut_barrel(game, player, target, params, item):
    bonus = max(1, _int(params, "DAMAGE", 1))
    player.sawn_off += 1
    player.sawn_bonus = bonus          # 真的加多少，由道具的 DAMAGE 決定
    game._log("modifier", f"{player.name} 鋸短了槍管，下一發 +{bonus} 傷害。")
    return [
        {"type": "MODIFIER", "playerId": player.id, "kind": "sawn",
         "power": 1 + bonus, "bonus": bonus}
    ], False


@register("nail_gun")
def _nail_gun(game, player, target, params, item):
    player.nails = max(0, _int(params, "SHOTS", 3))
    player.nail_damage = max(1, _int(params, "DAMAGE", 2))
    return [
        {"type": "MODIFIER", "playerId": player.id, "kind": "nails",
         "shots": player.nails, "damage": player.nail_damage}
    ], False


@register("steal_turn")
def _steal_turn(game, player, target, params, item):
    other = target or game._default_opponent(player) or player
    return [{"type": "STEAL_TURN", "playerId": player.id, "targetId": other.id}], True


@register("extra_turn")
def _extra_turn(game, player, target, params, item):
    ok = roll_chance(game, params, 100)
    return [{"type": "EXTRA_TURN", "playerId": player.id, "granted": ok}], ok


# ---------------------------------------------------------------------------
#  看牌類
# ---------------------------------------------------------------------------
@register("peek", "peek_many", "memory", "memory_all")
def _peek(game, player, target, params, item):
    count = 1 if item.get("effect") == "peek" else max(1, _int(params, "COUNT", 1))
    peek = game._peek(player, count)
    return ([peek] if peek else []), False


@register("peek_and_hurt")
def _peek_and_hurt(game, player, target, params, item):
    actions = []
    peek = game._peek(player, max(1, _int(params, "COUNT", 3)))
    if peek:
        actions.append(peek)
    dmg = max(0, _int(params, "DAMAGE", 1))
    if dmg:
        player.hp = max(0, player.hp - dmg)
        if player.hp <= 0:
            player.dead = True
        actions.append(
            {"type": "DAMAGE", "playerId": player.id, "targetId": player.id,
             "amount": dmg, "hp": player.hp, "dead": player.dead}
        )
    return actions, False


# ---------------------------------------------------------------------------
#  彈艙操作類
# ---------------------------------------------------------------------------
@register("eject", "eject_and_shoot")
def _eject(game, player, target, params, item):
    if not game.chamber:
        return [], False
    shell = game.chamber.pop(0)
    game._sync_counts()
    _on_intel_shift(game, 1)
    return [
        {"type": "EJECT", "playerId": player.id, "shell": shell, "remaining": game.remaining()}
    ], False


@register("eject_random")
def _eject_random(game, player, target, params, item):
    count = game.rng.randint(_int(params, "MIN", 1), _int(params, "MAX", 1))
    ejected = []
    for _ in range(max(0, count)):
        if not game.chamber:
            break
        ejected.append(game.chamber.pop(0))
    if not ejected:
        return [], False
    game._sync_counts()
    _on_intel_shift(game, len(ejected))
    return [
        {"type": "EJECT", "playerId": player.id, "shell": ejected[0],
         "shells": ejected, "remaining": game.remaining()}
    ], False


@register("invert")
def _invert(game, player, target, params, item):
    game.pending_inverted = True
    return [
        {"type": "MODIFIER", "playerId": player.id, "kind": "inverted",
         "next": game.chamber[0] if game.chamber else None}
    ], False


@register("rapid_fire")
def _rapid_fire(game, player, target, params, item):
    shots = max(1, _int(params, "SHOTS", 2))
    opponent = target or game._default_opponent(player)
    actions: list[dict[str, Any]] = [{"type": "BARRAGE", "playerId": player.id, "shots": shots}]
    for _ in range(shots):
        if opponent is None or opponent.dead or not game.chamber or game._check_winner():
            break
        shot = game.shoot(player.id, opponent.id)
        if shot:
            actions.append(shot)
            taunt = game._taunt_for_shot(shot)
            if taunt:
                actions.append(taunt)
    return actions, False


@register("gacha")
def _gacha(game, player, target, params, item):
    granted = game._grant_items(player, _int(params, "SHOTS", 3))
    names = [items_module.get_item(i)["name"] for i in granted if items_module.get_item(i)]
    return [
        {"type": "ITEMS_GRANTED", "playerId": player.id, "count": len(granted),
         "items": names, "reason": "gacha"}
    ], False


__all__ = ["EFFECTS", "register", "EffectTable"]
