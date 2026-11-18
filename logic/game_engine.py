""" ==========================================================================
  logic/game_engine.py —— 惡魔輪盤 核心引擎（唯一權威）
 ==========================================================================

  這一支檔案是整個遊戲的「真相」：
      · 子彈怎麼裝、怎麼洗（load_ammo）
      · 開槍怎麼結算、誰扣血、誰死（shoot）
      · 什麼時候換人、什麼時候換輪（finish_turn / reload）
      · 24 件道具的效果（_apply_item）
      · 玩家「看得到什麼」（state_for —— 絕不外洩子彈順序）

  伺服器（app.py）只負責「轉發意圖 + 廣播結果」，不做任何規則判斷；
  前端送來的 damage / shell / hp 一律不採信（execute() 只讀 player_id、
  intent、payload 裡的 target_id 與 item_id）。

  ---------------------------------------------------------------------------
  對外介面（app.py 依賴這幾個）
  ---------------------------------------------------------------------------
      Game.create(room_code, seats, config=None) -> Game
      game.start() -> list[dict]
      game.execute(player_id, intent, payload) -> {"ok": True, "actions": [...]}
                                               | {"ok": False, "error": "..."}
      game.state_for(player_id) -> {"public": {...}, "private": {...}}
      game.reveal_remaining_ms() -> int
      game.release_reveal() -> list[dict]
      game.reveal_chamber() -> list[str] | None
      game.active_id / phase / version / winner_id / round
      game.player(pid) / active_player() / is_ai_turn()

      choose_ai_intent(game) -> {"type": ..., "payload": {...}}
      ai_think_delay(game) -> float（秒）
 ========================================================================== """

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from config import items as items_module
from logic import dialogue

# ---------------------------------------------------------------------------
#  常數
# ---------------------------------------------------------------------------
LIVE = "LIVE"
BLANK = "BLANK"

PHASE_LOBBY = "lobby"
PHASE_PLAYING = "playing"
PHASE_OVER = "gameover"

BASE_DAMAGE = 1
MAX_ITEMS_PER_TURN = 3
LOG_LIMIT = 40

# 這些道具的效果本身就代表「這一回合的動作結束了」，不額外再送一次 TURN_CHANGED
NO_TURN_COST_EFFECTS = {"extra_turn"}

# execute() 只接受這幾種意圖；其他字串一律 UNKNOWN_INTENT
LEGAL_INTENTS = frozenset({"SHOOT", "USE_ITEM", "GUARD", "TIMEOUT"})

ERRORS = {
    "GAME_NOT_PLAYING": "遊戲還沒開始，或已經結束了。",
    "PLAYER_NOT_FOUND": "找不到這位玩家。",
    "PLAYER_DEAD": "你已經死了，安靜看戲。",
    "NOT_YOUR_TURN": "還沒輪到你。",
    "AMMO_REVEAL": "正在公布本回合彈藥，稍等。",
    "UNKNOWN_INTENT": "未知的動作。",
    "UNKNOWN_ITEM": "沒有這種道具。",
    "NO_ITEM": "你身上沒有這件道具。",
    "TOO_MANY_ITEMS": "這回合用太多道具了。",
    "NO_TARGET": "找不到可以下手的對象。",
    "BAD_PAYLOAD": "送來的參數不正確。",
    "HP_FULL": "生命值已經滿了，留著之後再用吧。",
}


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _describe(error: str) -> str:
    return ERRORS.get(error, error)


# ---------------------------------------------------------------------------
#  玩家
# ---------------------------------------------------------------------------
@dataclass
class Player:
    id: str
    name: str
    is_ai: bool = False
    hp: int = 0
    max_hp: int = 0
    dead: bool = False

    # 道具欄（只存 id，效果定義在 config/items.py）
    items: list[str] = field(default_factory=list)

    # 這名玩家透過道具「記住」的子彈（只給他自己看）
    intel: list[str] = field(default_factory=list)

    # 本回合 / 本輪的增益
    sawn_off: int = 0        # 手鋸：下一發 +1 傷害
    nails: int = 0           # 釘槍：接下來 N 發造成 nail_damage
    nail_damage: int = 2
    skips: int = 0           # 手銬：被跳過的回合數

    # 每回合的節流
    items_this_turn: int = 0
    last_item_id: str | None = None

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "isAI": self.is_ai,
            "hp": self.hp,
            "maxHp": self.max_hp,
            "dead": self.dead,
            "itemCount": len(self.items),
        }


# ---------------------------------------------------------------------------
#  遊戲
# ---------------------------------------------------------------------------
class Game:
    """一局遊戲。所有狀態都在這裡，沒有任何隱藏的模組級可變狀態。"""

    def __init__(
        self,
        room_code: str,
        seats: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        *,
        clock: Callable[[], float] | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self.room_code = room_code
        self.config = config if config is not None else _default_config()
        self.clock = clock or time.monotonic
        self.rng = rng or random.Random()

        hp_cfg = self.config["HP"]
        start_hp = int(hp_cfg["START_HP"])
        start_max = int(hp_cfg.get("START_MAX_HP", start_hp))
        self.players: list[Player] = [
            Player(
                id=str(seat["id"]),
                name=str(seat.get("name") or seat["id"]),
                is_ai=bool(seat.get("is_ai") or seat.get("isAI")),
                hp=start_hp,
                max_hp=start_max,
            )
            for seat in seats
        ]

        self.phase: str = PHASE_LOBBY
        self.round: int = 1
        self.version: int = 0
        self.winner_id: str | None = None

        self.chamber: list[str] = []
        self.live: int = 0
        self.blank: int = 0

        self.turn: dict[str, Any] = {"active_id": None, "chain": 0, "started_at": self.clock()}
        self.log: list[dict[str, Any]] = []
        self._log_id = 0

        # 換輪時失效的東西
        self.pending_inverted: bool = False

        # 開局彈藥提示（裝填鎖）
        self.reveal_ms_value: int = 0
        self.reveal_until: float = 0.0   # 毫秒（用 clock() * 1000 比較）

        # 台詞冷卻
        self._taunt_at: float = 0.0

    # -- 建立 -------------------------------------------------------------
    @classmethod
    def create(
        cls,
        room_code: str,
        seats: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> "Game":
        return cls(room_code, seats, config, **kwargs)

    # -- 屬性 -------------------------------------------------------------
    @property
    def active_id(self) -> str | None:
        return self.turn.get("active_id")

    def active_player(self) -> Player | None:
        return self.player(self.active_id)

    def is_ai_turn(self) -> bool:
        active = self.active_player()
        return bool(active and active.is_ai)

    def player(self, player_id: str | None) -> Player | None:
        if player_id is None:
            return None
        for p in self.players:
            if p.id == player_id:
                return p
        return None

    def alive_players(self) -> list[Player]:
        return [p for p in self.players if not p.dead]

    def opponents_of(self, player: Player) -> list[Player]:
        return [p for p in self.players if p.id != player.id and not p.dead]

    # ------------------------------------------------------------------
    #  裝彈（本專案的重點）
    # ------------------------------------------------------------------
    def load_ammo(self, round_number: int | None = None) -> dict[str, Any]:
        """
        依 config 的規則產生一個「打亂的子彈陣列」。

        步驟
        ----
          1. 這一輪幾發：BASE + (round-1)*STEP ± JITTER，夾在 MIN_SHELLS ~ MAX_SHELLS
          2. 這一輪該有多少實彈：總數 × LIVE_WEIGHT[round]（越後面越危險）
          3. 無偏差取整：整數部分無條件保留，小數部分用一次隨機決定進不進位
             （直接用 round() 會讓期望值偏高，實測會變成 0.6 而不是 0.5）
          4. LIVE_VARIANCE 的機率再 ±1 發，然後夾到「至少 1 實 1 空」
          5. 用 Fisher–Yates 洗牌 → 順序不可預測
        """
        rnd = round_number if round_number is not None else self.round
        ammo = self.config["AMMO"]

        # 0. 人數：人多 → 子彈多。4 人局一輪只有 2~3 發的話打沒幾下就沒牌了。
        player_count = len(self.players)
        extra_players = max(0, player_count - 2)

        # 1. 總數 = BASE + (round-1)*STEP ± JITTER + 人數加成
        total = int(ammo["SHELLS_PER_ROUND_BASE"]) + (rnd - 1) * int(ammo["SHELLS_PER_ROUND_STEP"])
        jitter = int(ammo.get("SHELLS_PER_ROUND_JITTER", 0))
        if jitter > 0:
            total += self.rng.randint(-jitter, jitter)
        shells_per_extra = int(ammo.get("SHELLS_PER_EXTRA_PLAYER", 2))
        total += extra_players * shells_per_extra
        min_live = max(0, int(ammo.get("MIN_LIVE", 1)))
        min_blank = max(0, int(ammo.get("MIN_BLANK", 1)))
        # 下限也不能低於「1 實 + 1 空」，否則下面的夾制會互相打架
        min_shells = max(int(ammo["MIN_SHELLS"]), min_live + min_blank)
        total = int(_clamp(total, min_shells, int(ammo["MAX_SHELLS"])))

        # 2. 實彈期望值
        #weight = _live_weight_from(self.config, rnd)
        # 完全隨機產生 20% ~ 60% 的實彈機率
        weight = self.rng.uniform(0.2, 0.6)
        low, high = min_live, max(min_live, total - min_blank)

        # 3. 無偏差取整
        target = _clamp(total * weight, low, high)
        whole = math.floor(target)
        fraction = target - whole
        live_count = whole + (1 if self.rng.random() < fraction else 0)

        # 4. 抖動
        variance = float(ammo.get("LIVE_VARIANCE", 0))
        if variance > 0 and self.rng.random() < variance:
            live_count += self.rng.choice((-1, 1))

        # 4-1. 實彈的人數加成：floor((人數 - 2) * LIVE_PER_EXTRA_PLAYER)
        live_per_extra = float(ammo.get("LIVE_PER_EXTRA_PLAYER", 0.5))
        live_bonus = math.floor(extra_players * live_per_extra)
        live_count += live_bonus

        # 5. 收斂：實彈 + 空包 = 總數，而且至少留 min_blank 發空包彈
        live_count = int(_clamp(live_count, min_live if total >= min_live + min_blank else 0, max(0, total - min_blank)))
        blank_count = total - live_count

        # 6. 洗牌
        chamber = [LIVE] * live_count + [BLANK] * blank_count
        for i in range(len(chamber) - 1, 0, -1):
            j = self.rng.randrange(i + 1)
            chamber[i], chamber[j] = chamber[j], chamber[i]

        return {
            "chamber": chamber,
            "live": live_count,
            "blank": blank_count,
            "total": total,
            "playerCount": player_count,   # 給 RELOAD 播報用
            "liveBonus": live_bonus,       # 人數多出來的那幾發實彈
        }

    def _set_chamber(self, chamber: list[str]) -> None:
        self.chamber = list(chamber)
        self._sync_counts()

    def _sync_counts(self) -> None:
        self.live = sum(1 for s in self.chamber if s == LIVE)
        self.blank = len(self.chamber) - self.live

    def remaining(self) -> dict[str, int]:
        """給前端看的「剩幾發」（不含順序）。"""
        return {"live": self.live, "blank": self.blank, "total": self.live + self.blank}

    # ------------------------------------------------------------------
    #  開局
    # ------------------------------------------------------------------
    def start(self) -> list[dict[str, Any]]:
        self.phase = PHASE_PLAYING
        self.round = 1
        self.version += 1
        self.winner_id = None
        self.log = []
        self.pending_inverted = False
        self._taunt_at = 0.0

        hp_cfg = self.config["HP"]
        for p in self.players:
            p.hp = int(hp_cfg["START_HP"])
            p.max_hp = int(hp_cfg.get("START_MAX_HP", p.hp))
            p.dead = False
            p.items = []
            p.intel = []
            p.sawn_off = 0
            p.nails = 0
            p.skips = 0
            p.items_this_turn = 0
            p.last_item_id = None

        self.turn = {"active_id": self.players[0].id, "chain": 0, "started_at": self.clock()}

        actions: list[dict[str, Any]] = [
            {
                "type": "GAME_START",
                "round": 1,
                "players": [p.to_public() for p in self.players],
            }
        ]
        actions.extend(self._reload(initial=True))
        actions.append(self._turn_action(kept=True))
        self._log("game", f"遊戲開始：{len(self.players)} 人入座。")

        taunt = self._taunt("onGameStart")
        if taunt:
            actions.append(taunt)
        return actions

    # ------------------------------------------------------------------
    #  換輪 / 重新裝彈
    # ------------------------------------------------------------------
    def _reload(self, initial: bool = False) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []
        ammo = self.config["AMMO"]

        load = self.load_ammo(self.round)
        self._set_chamber(load["chamber"])
        self.pending_inverted = False

        # 每輪重置的增益（原版：換彈時槍管長回去、手銬在這一輪開始前解除）
        for p in self.players:
            p.sawn_off = 0
            p.nails = 0
            p.intel = []
            p.skips = 0
            p.items_this_turn = 0
            p.last_item_id = None

        actions.append(
            {
                "type": "RELOAD",
                "round": self.round,
                "total": load["total"],
                "live": load["live"],
                "blank": load["blank"],
                # 人數加成後的資訊（前端可以用來顯示「人多加彈」）
                "playerCount": load.get("playerCount", len(self.players)),
                "liveBonus": load.get("liveBonus", 0),
            }
        )
        self._log(
            "reload",
            f"第 {self.round} 輪裝填：{load['live']} 發實彈 / {load['blank']} 發空包彈。",
        )

        # 回血
        if bool(ammo.get("HEAL_ON_RELOAD")) and not initial:
            for p in self.players:
                if p.dead or p.hp >= p.max_hp:
                    continue
                healed = min(1, p.max_hp - p.hp)
                if healed > 0:
                    p.hp += healed
                    actions.append(
                        {"type": "HEAL", "playerId": p.id, "amount": healed, "hp": p.hp, "reason": "reload"}
                    )

        # 發道具
        count = _item_grant_count_from(self.config, self.round)
        for p in self.players:
            if p.dead:
                continue
            granted = self._grant_items(p, count)
            if granted and not p.is_ai:
                actions.append(
                    {
                        "type": "ITEMS_GRANTED",
                        "playerId": p.id,
                        "count": len(granted),
                        "items": [items_module.get_item(i)["name"] for i in granted if items_module.get_item(i)],
                    }
                )
                self._log("item", f"{p.name} 拿到 {len(granted)} 件道具。")

        # 裝填鎖（開局提示 3 秒）
        self._arm_reveal()
        actions.append(self._reveal_action())

        if not initial:
            taunt = self._taunt(
                "onReload",
                {"round": self.round, "live": load["live"], "blank": load["blank"]},
            )
            if taunt:
                actions.append(taunt)
        return actions

    # ------------------------------------------------------------------
    #  開槍
    # ------------------------------------------------------------------
    def shoot(self, shooter_id: str, target_id: str | None = None) -> dict[str, Any] | None:
        """
        從彈艙取出第一發子彈並結算。
        回傳 action dict；如果需要切換回合，由呼叫端（execute）處理。
        """
        shooter = self.player(shooter_id)
        if shooter is None or not self.chamber:
            return None

        target = self.player(target_id) or shooter
        if target.dead:
            target = shooter

        shell = self.chamber.pop(0)

        # 逆轉器：反轉這一發
        inverted = False
        if self.pending_inverted:
            shell = BLANK if shell == LIVE else LIVE
            inverted = True
            self.pending_inverted = False

        self._sync_counts()

        # 傷害計算（手鋸 / 釘槍都是「這名玩家」自己的增益）
        power = BASE_DAMAGE
        if shooter.sawn_off > 0:
            power += 1
            shooter.sawn_off -= 1
        if shooter.nails > 0:
            power = max(power, shooter.nail_damage)
            shooter.nails -= 1

        real = shell == LIVE
        damage = 0
        target_dead = False
        if real:
            damage = power
            target.hp = max(0, target.hp - damage)
            if target.hp <= 0:
                target.dead = True
                target_dead = True

        # 所有人「記住的順序」都往前推一格
        for p in self.players:
            if p.intel:
                p.intel.pop(0)

        action: dict[str, Any] = {
            "type": "SHOT",
            "shooterId": shooter.id,
            "shooterName": shooter.name,
            "targetId": target.id,
            "targetName": target.name,
            "selfShot": target.id == shooter.id,
            "shell": shell,
            "realShell": real,
            "inverted": inverted,
            "power": power,
            "damage": damage,
            "hp": target.hp,
            "maxHp": target.max_hp,
            "targetDead": target_dead,
            "remaining": self.remaining(),
            "round": self.round,
            "chain": self.turn.get("chain", 0),
            "lastShell": len(self.chamber) == 0,
        }

        if real:
            self._log("shot", f"{shooter.name} 對 {target.name} 開槍：實彈，{damage} 點傷害。")
        else:
            self._log("shot", f"{shooter.name} 對 {target.name} 開槍：空包彈。")

        return action

    # ------------------------------------------------------------------
    #  換人 / 換輪
    # ------------------------------------------------------------------
    def _next_alive(self) -> Player | None:
        alive = [p for p in self.players if not p.dead]
        if not alive:
            return None
        current = self.active_player()
        order = self.players
        start = order.index(current) if current in order else -1

        # 每次略過都會消耗一個 skips；掃完所有存活者的略過次數後，
        # 再多走一圈即可找到下一位可行動玩家。
        max_steps = len(order) + sum(max(0, player.skips) for player in alive)
        for _ in range(max_steps):
            start = (start + 1) % len(order)
            candidate = order[start]
            if candidate.dead:
                continue
            if candidate.skips > 0:
                candidate.skips -= 1
                self._log("skip", f"{candidate.name} 被手銬銬住，跳過這一回合。")
                continue
            return candidate
        raise RuntimeError("Unable to find an eligible player despite living players")

    def _round_starter(self) -> Player | None:
        """一輪結束、重新裝彈後的第一個行動者：從第 1 個座位往後找第一個活人。"""
        for p in self.players:
            if not p.dead:
                return p
        return None

    def _finish_turn(self, keep_turn: bool, count_chain: bool = True) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []

        winner = self._check_winner()
        if winner is not None:
            actions.extend(self._game_over(winner))
            return actions

        if not self.chamber:
            actions.append({"type": "ROUND_END", "round": self.round})
            self._log("round", f"第 {self.round} 輪結束。")
            self.round += 1
            actions.extend(self._reload())

            # 原版：重新裝彈後牌桌重來，固定由「玩家」這一側先手，
            # 不管上一輪最後一發是誰打的、是不是空包續杯。
            rule = str((self.config.get("RULES") or {}).get("ROUND_START_TURN", "first")).lower()
            previous = self.active_player()
            if rule == "shooter" and keep_turn:
                starter = previous
            else:
                starter = self._round_starter()
            self.turn["active_id"] = starter.id if starter else None
            self.turn["chain"] = 0
            self.turn["started_at"] = self.clock()
            kept = bool(keep_turn and starter and previous and starter.id == previous.id)
            actions.append(self._turn_action(kept=kept))
            return actions

        if keep_turn:
            if count_chain:
                self.turn["chain"] = self.turn.get("chain", 0) + 1
            actions.append(self._turn_action(kept=True))
            return actions

        nxt = self._next_alive()
        self.turn["active_id"] = nxt.id if nxt else None
        self.turn["chain"] = 0
        self.turn["started_at"] = self.clock()
        actions.append(self._turn_action())
        return actions

    def _turn_action(self, kept: bool = False) -> dict[str, Any]:
        active = self.active_player()
        return {
            "type": "TURN_CHANGED",
            "activeId": active.id if active else None,
            "activeName": active.name if active else None,
            "kept": bool(kept),
            "chain": self.turn.get("chain", 0),
            "round": self.round,
            "remaining": self.remaining(),
        }

    def _check_winner(self) -> Player | None:
        alive = self.alive_players()
        if len(alive) <= 1:
            return alive[0] if alive else None
        return None

    def _game_over(self, winner: Player) -> list[dict[str, Any]]:
        self.phase = PHASE_OVER
        self.winner_id = winner.id
        self.turn["active_id"] = None
        self._log("over", f"{winner.name} 獲勝。")
        actions: list[dict[str, Any]] = [
            {
                "type": "GAME_OVER",
                "winnerId": winner.id,
                "winnerName": winner.name,
                "players": [p.to_public() for p in self.players],
            }
        ]
        taunt = self._taunt("onVictory" if winner.is_ai else "onDefeat")
        if taunt:
            actions.append(taunt)
        return actions

    # ------------------------------------------------------------------
    #  對外入口
    # ------------------------------------------------------------------
    def execute(self, player_id: str, intent: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """唯一的動作入口 —— 所有防作弊檢查都在這裡做，呼叫端一律不可信。

        檢查順序（任何一步沒過就回錯誤，遊戲狀態完全不會改變）：
          1. 遊戲必須進行中
          2. player_id 必須是這局真的存在的玩家
          3. 死人不能行動
          4. 裝填鎖期間誰都不能動
          5. intent 必須在白名單裡
          6. **輪次檢查：player.id != self.active_id → NOT_YOUR_TURN**
             （SHOOT 與 USE_ITEM 都走這條，沒有例外）

        payload 只認「意圖」欄位（target_id / item_id）；傷害、血量、子彈種類
        全部由引擎自己算，前端送什麼都不會被採用。
        """
        if not isinstance(payload, dict):
            payload = {}

        if self.phase != PHASE_PLAYING:
            return {"ok": False, "error": "GAME_NOT_PLAYING"}

        player = self.player(player_id)
        if player is None:
            return {"ok": False, "error": "PLAYER_NOT_FOUND"}
        if player.dead:
            return {"ok": False, "error": "PLAYER_DEAD"}

        if self.reveal_remaining_ms() > 0:
            return {"ok": False, "error": "AMMO_REVEAL"}

        intent = str(intent or "").upper()
        if intent not in LEGAL_INTENTS:
            return {"ok": False, "error": "UNKNOWN_INTENT"}

        # ── 防作弊：不是你的回合，SHOOT / USE_ITEM 一律擋掉 ──
        active_id = self.active_id
        if active_id is None or player.id != active_id:
            return {"ok": False, "error": "NOT_YOUR_TURN"}

        if intent in {"SHOOT", "GUARD", "TIMEOUT"}:
            actions = self._command_shoot(player, payload, timeout=intent == "TIMEOUT")
        elif intent == "USE_ITEM":
            result = self._command_use_item(player, payload)
            if not result.get("ok"):
                return result
            actions = result["actions"]
        else:
            return {"ok": False, "error": "UNKNOWN_INTENT"}

        self.version += 1
        return {"ok": True, "actions": actions, "version": self.version}

    def _command_shoot(
        self, player: Player, payload: dict[str, Any], timeout: bool = False
    ) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []
        if timeout:
            actions.append({"type": "TIMEOUT", "playerId": player.id, "name": player.name})
            self._log("timeout", f"{player.name} 想太久，伺服器替他扣了扳機。")

        target_id = payload.get("target_id")
        target = self.player(target_id) if isinstance(target_id, str) else None
        if target_id in (None, "", "self"):
            target = None
        if target is None or target.dead or target.id == player.id:
            target = None  # None = 對自己

        shot = self.shoot(player.id, target.id if target else player.id)
        if shot is None:
            return actions + self._finish_turn(False)
        actions.append(shot)

        taunt = self._taunt_for_shot(shot)
        if taunt:
            actions.append(taunt)

        if shot["targetDead"]:
            pass  # _finish_turn 會處理勝負

        self_player = self.player(player.id)
        keep = bool(shot["selfShot"] and not shot["realShell"] and self_player and not self_player.dead)
        actions.extend(self._finish_turn(keep))
        return actions

    def _command_use_item(self, player: Player, payload: dict[str, Any]) -> dict[str, Any]:
        item_id = payload.get("item_id")
        if not isinstance(item_id, str) or not item_id:
            return {"ok": False, "error": "BAD_PAYLOAD"}
        item = items_module.get_item(item_id)
        if item is None:
            return {"ok": False, "error": "UNKNOWN_ITEM"}
        if item_id not in player.items:
            return {"ok": False, "error": "NO_ITEM"}
        if player.items_this_turn >= MAX_ITEMS_PER_TURN:
            return {"ok": False, "error": "TOO_MANY_ITEMS"}
        if self._heal_blocked(player, item):
            return {"ok": False, "error": "HP_FULL"}

        player.items.remove(item_id)
        player.items_this_turn += 1
        player.last_item_id = item_id

        actions: list[dict[str, Any]] = [
            {
                "type": "ITEM_USED",
                "playerId": player.id,
                "playerName": player.name,
                "itemId": item_id,
                "itemName": item["name"],
                "icon": item.get("icon") or "❓",
                "desc": items_module.describe_item(item),
            }
        ]
        self._log("item", f"{player.name} 使用了「{item['name']}」。")

        target_id = payload.get("target_id")
        target = self.player(target_id) if isinstance(target_id, str) else None
        if target is None or target.dead:
            target = None

        extra, extends = self._apply_item(player, item, target)
        actions.extend(extra)

        taunt = self._taunt("onDemonItem" if player.is_ai else "onItemUsed")
        if taunt:
            actions.append(taunt)

        if self._check_winner() is not None:
            actions.extend(self._finish_turn(False, count_chain=False))
            return {"ok": True, "actions": actions}

        keep = bool(extends or item.get("keeps_turn") is True)
        actions.extend(self._finish_turn(keep, count_chain=False))
        return {"ok": True, "actions": actions}

    # ------------------------------------------------------------------
    #  道具效果
    # ------------------------------------------------------------------
    def _heal_blocked(self, player: Player, item: dict[str, Any]) -> bool:
        """
        滿血時擋下「純回血」道具。

        原版（ItemInteraction.gd → HealthCounter.UpdateDisplayRoutineCigarette_Player）
        沒有任何防呆：`health_player += 1` 之後才 clamp 到上限，
        所以滿血抽菸＝道具白白消耗、一點血都沒補。
        這裡預設把這種浪費擋下來，想要原版手感就把 RULES.STRICT_HEAL 設成 False。
        """
        rules = self.config.get("RULES") or {}
        if not bool(rules.get("STRICT_HEAL", True)):
            return False
        if item.get("effect") not in {"heal", "random_heal"}:
            return False
        return player.hp >= player.max_hp

    def _heal(self, player: Player, amount: int) -> dict[str, Any] | None:
        amount = int(amount)
        if amount <= 0 or player.dead:
            return None
        healed = min(amount, player.max_hp - player.hp)
        if healed <= 0:
            return None
        player.hp += healed
        return {"type": "HEAL", "playerId": player.id, "amount": healed, "hp": player.hp}

    def _peek(self, player: Player, count: int) -> dict[str, Any] | None:
        count = max(1, int(count))
        shells = self.chamber[:count]
        if not shells:
            return None
        player.intel = list(shells)
        return {"type": "PEEK", "playerId": player.id, "shells": shells}

    def _default_opponent(self, player: Player) -> Player | None:
        others = self.opponents_of(player)
        return others[0] if others else None

    def _apply_item(
        self, player: Player, item: dict[str, Any], target: Player | None
    ) -> tuple[list[dict[str, Any]], bool]:
        """回傳 (動作串, 是否保留回合)。資料驅動的通用處理器。"""
        actions: list[dict[str, Any]] = []
        effect = item.get("effect")
        params = item.get("params") or {}
        extends = False

        # ==========================================
        # 👇 通用數值修改類 (只要在 items.py 改數字就能生效)
        # ==========================================
        
        if effect == "deal_damage":
            dmg = int(params.get("DAMAGE", 1))
            victim = target or self._default_opponent(player)
            if victim and not victim.dead:
                victim.hp = max(0, victim.hp - dmg)
                if victim.hp <= 0: victim.dead = True
                actions.append({"type": "DAMAGE", "playerId": victim.id, "amount": dmg, "hp": victim.hp, "dead": victim.dead})
                self._log("damage", f"{player.name} 對 {victim.name} 造成了 {dmg} 點傷害。")

        elif effect == "heal":
            if "HP" in params:
                amount = int(params["HP"])
            else:
                amount = self.rng.randint(int(params.get("MIN", 1)), int(params.get("MAX", 1)))
            healed = self._heal(player, amount)
            if healed:
                actions.append(healed)
                self._log("heal", f"{player.name} 回復 {healed['amount']} 點生命。")

        elif effect == "max_hp_up":
            cost = int(params.get("HP", 1))
            gain = int(params.get("MAX_HP", 1))
            player.hp = max(1, player.hp - cost)
            player.max_hp = min(int(self.config["HP"]["MAX_HP"]), player.max_hp + gain)
            actions.append({"type": "MODIFIER", "playerId": player.id, "kind": "max_hp", "hp": player.hp, "maxHp": player.max_hp})

        elif effect == "skip_next":
            victim = target or self._default_opponent(player)
            if victim:
                victim.skips += int(params.get("SKIPS", 1))
                actions.append({"type": "MODIFIER", "playerId": player.id, "targetId": victim.id, "kind": "cuffed", "skips": victim.skips})

        elif effect == "cut_barrel":
            player.sawn_off += 1
            actions.append({"type": "MODIFIER", "playerId": player.id, "kind": "sawn", "power": 1 + player.sawn_off})
            self._log("modifier", f"{player.name} 鋸短了槍管，下一發更痛。")

        elif effect == "nail_gun":
            player.nails = int(params.get("SHOTS", 3))
            player.nail_damage = int(params.get("DAMAGE", 2))
            actions.append({"type": "MODIFIER", "playerId": player.id, "kind": "nails", "shots": player.nails, "damage": player.nail_damage})

        elif effect == "steal_turn":
            extends = True
            actions.append({"type": "STEAL_TURN", "playerId": player.id, "targetId": (target or self._default_opponent(player) or player).id})

        elif effect == "extra_turn":
            chance = float(params.get("CHANCE", 100)) / 100.0
            if self.rng.random() < chance:
                extends = True
                actions.append({"type": "EXTRA_TURN", "playerId": player.id, "granted": True})
            else:
                actions.append({"type": "EXTRA_TURN", "playerId": player.id, "granted": False})

        # ==========================================
        # 👇 特殊邏輯類 (因為太複雜，保留專屬處理)
        # ==========================================

        elif effect == "random_heal":
            if self.rng.random() < float(params.get("CHANCE", 50)) / 100.0:
                amount = self.rng.randint(int(params.get("MIN", 1)), int(params.get("MAX", 1)))
                healed = self._heal(player, amount)
                if healed: actions.append(healed)
            else:
                actions.append({"type": "ITEM_FAILED", "playerId": player.id, "itemId": item["id"], "reason": "no_effect"})

        elif effect in {"peek", "peek_many", "memory", "memory_all"}:
            count = int(params.get("COUNT", 1)) if effect != "peek" else 1
            peek = self._peek(player, count)
            if peek: actions.append(peek)

        elif effect == "peek_and_hurt":
            count = int(params.get("COUNT", 3))
            dmg = int(params.get("DAMAGE", 1))
            peek = self._peek(player, count)
            if peek: actions.append(peek)
            player.hp = max(0, player.hp - dmg)
            if player.hp <= 0: player.dead = True
            actions.append({"type": "DAMAGE", "playerId": player.id, "amount": dmg, "hp": player.hp, "dead": player.dead})

        elif effect == "eject":
            if self.chamber:
                shell = self.chamber.pop(0)
                self._sync_counts()
                for p in self.players:
                    if p.intel: p.intel.pop(0)
                actions.append({"type": "EJECT", "playerId": player.id, "shell": shell, "remaining": self.remaining()})

        elif effect == "eject_random":
            count = self.rng.randint(int(params.get("MIN", 1)), int(params.get("MAX", 1)))
            ejected = []
            for _ in range(count):
                if not self.chamber: break
                ejected.append(self.chamber.pop(0))
            if ejected:
                self._sync_counts()
                for p in self.players: p.intel = p.intel[len(ejected):]
                actions.append({"type": "EJECT", "playerId": player.id, "shell": ejected[0], "shells": ejected, "remaining": self.remaining()})

        elif effect == "invert":
            self.pending_inverted = True
            actions.append({"type": "MODIFIER", "playerId": player.id, "kind": "inverted", "next": self.chamber[0] if self.chamber else None})

        elif effect == "gacha":
            granted = self._grant_items(player, int(params.get("SHOTS", 3)))
            actions.append({"type": "ITEMS_GRANTED", "playerId": player.id, "count": len(granted), "items": [items_module.get_item(i)["name"] for i in granted if items_module.get_item(i)], "reason": "gacha"})

        elif effect == "gamble_heal":
            if self.rng.random() < float(params.get("CHANCE", 50)) / 100.0:
                amount = self.rng.randint(int(params.get("MIN", 1)), int(params.get("MAX", 1)))
                healed = self._heal(player, amount)
                if healed: actions.append(healed)
            else:
                dmg = int(params.get("HP", 1))
                player.hp = max(0, player.hp - dmg)
                if player.hp <= 0: player.dead = True
                actions.append({"type": "DAMAGE", "playerId": player.id, "amount": dmg, "hp": player.hp, "dead": player.dead})

        elif effect == "rapid_fire":
            shots = int(params.get("SHOTS", 2))
            opponent = target or self._default_opponent(player)
            actions.append({"type": "BARRAGE", "playerId": player.id, "shots": shots})
            for _ in range(shots):
                if opponent is None or opponent.dead or not self.chamber or self._check_winner(): break
                shot = self.shoot(player.id, opponent.id)
                if shot:
                    actions.append(shot)
                    taunt = self._taunt_for_shot(shot)
                    if taunt: actions.append(taunt)
            extends = False

        else:
            actions.append({"type": "ITEM_FAILED", "playerId": player.id, "itemId": item["id"], "reason": "unsupported"})

        return actions, extends

    def _grant_items(self, player: Player, count: int) -> list[str]:
        from config.game_config import item_cap, max_items

        granted: list[str] = []
        for _ in range(max(0, int(count))):
            if len(player.items) >= max_items():
                break
            item_id: str | None = None
            # 原版：身上已經有 2 支菸時，把「cigarettes」從獎池裡移除再抽。
            # 這裡用重抽代替（最多 4 次），避免抽不到東西。
            for _attempt in range(4):
                candidate = items_module.roll_loot(self.rng, "ENEMY" if player.is_ai else "PLAYER")
                if not candidate:
                    continue
                cap = item_cap(candidate)
                if cap > 0 and player.items.count(candidate) >= cap:
                    continue
                item_id = candidate
                break
            if not item_id:
                continue
            player.items.append(item_id)
            granted.append(item_id)
        return granted

    # ------------------------------------------------------------------
    #  開局彈藥提示（裝填鎖）
    # ------------------------------------------------------------------
    def _arm_reveal(self) -> None:
        ammo = self.config["AMMO"].get("AMMO_REVEAL") or {}
        enabled = bool(ammo.get("ENABLED", True))
        ms = int(ammo.get("REVEAL_MS", 0)) if enabled else 0
        self.reveal_ms_value = max(0, ms)
        self.reveal_until = self.clock() * 1000.0 + self.reveal_ms_value if self.reveal_ms_value > 0 else 0.0

    def reveal_remaining_ms(self) -> int:
        if self.reveal_until <= 0:
            return 0
        left = self.reveal_until - self.clock() * 1000.0
        return max(0, int(math.ceil(left)))

    def release_reveal(self) -> list[dict[str, Any]]:
        """時間到 → 解除裝填鎖（重複呼叫是安全的）。"""
        if self.reveal_remaining_ms() > 0:
            return []
        self.reveal_until = 0.0
        self.reveal_ms_value = 0
        active = self.active_player()
        return [
            {
                "type": "AMMO_REVEAL_END",
                "round": self.round,
                "activeId": active.id if active else None,
                "activeName": active.name if active else None,
                "remaining": self.remaining(),
            }
        ]

    def _reveal_action(self) -> dict[str, Any]:
        return {
            "type": "AMMO_REVEAL",
            "round": self.round,
            "total": self.live + self.blank,
            "live": self.live,
            "blank": self.blank,
            "ms": self.reveal_ms_value,
        }

    def reveal_chamber(self) -> list[str] | None:
        """只有遊戲結束才公布完整順序。"""
        if self.phase != PHASE_OVER:
            return None
        return list(self.chamber)

    # ------------------------------------------------------------------
    #  DeepSeek 娘台詞
    # ------------------------------------------------------------------
    def demon(self) -> Player | None:
        for p in self.players:
            if p.is_ai:
                return p
        return None

    def _taunt(self, event_type: str, variables: dict[str, Any] | None = None) -> dict[str, Any] | None:
        cfg = self.config.get("DIALOGUE") or {}
        if not cfg.get("ENABLED", True):
            return None
        now = self.clock()
        cooldown = float(cfg.get("COOLDOWN_MS", 0)) / 1000.0
        if self._taunt_at and now - self._taunt_at < cooldown:
            return None

        chance = float((cfg.get("CHANCE") or {}).get(event_type, cfg.get("DEFAULT_CHANCE", 0.55)))
        if chance <= 0:
            return None

        demon = self.demon()
        names = {"demon": demon.name if demon else cfg.get("SPEAKER", "DeepSeek 娘")}
        if variables:
            names.update(variables)

        text = dialogue.get_taunt(event_type, rng=self.rng, chance=chance, variables=names)
        if not text:
            return None
        self._taunt_at = now
        return {
            "type": "TAUNT",
            "eventType": event_type,
            "speaker": "demon",
            "speakerId": demon.id if demon else None,
            "speakerName": names.get("demon"),
            "text": text,
        }

    def _taunt_for_shot(self, shot: dict[str, Any]) -> dict[str, Any] | None:
        shooter = self.player(shot["shooterId"])
        target = self.player(shot["targetId"])
        if shooter is None or target is None:
            return None

        if shot["targetDead"]:
            return self._taunt("onDemonDeath" if target.is_ai else "onPlayerDeath")

        variables = {
            "player": shooter.name,
            "damage": shot["damage"],
            "hp": target.hp,
        }

        if target.is_ai and shot["realShell"]:
            return self._taunt("onDemonHurt", variables)
        if target.is_ai and not shot["realShell"]:
            return self._taunt("onPlayerBlank", variables)
        if shooter.is_ai and shot["realShell"]:
            return self._taunt("onPlayerHurt", variables)

        if shooter.is_ai:
            if shot["selfShot"]:
                return self._taunt("onDemonShootSelf", variables)
            if not shot["realShell"]:
                return self._taunt("onDemonBlank", variables)
            return self._taunt("onDemonShoot", variables)

        if shot["selfShot"]:
            return self._taunt("onPlayerShootSelf", variables)
        if not shot["realShell"]:
            return self._taunt("onPlayerBlank", variables)
        return self._taunt("onPlayerShootDemon", variables)

    # ------------------------------------------------------------------
    #  給前端的狀態（絕不外洩順序）
    # ------------------------------------------------------------------
    def _public_state(self) -> dict[str, Any]:
        active = self.active_player()
        return {
            "roomCode": self.room_code,
            "phase": self.phase,
            "round": self.round,
            "version": self.version,
            "winnerId": self.winner_id,
            "activeId": active.id if active else None,
            "activeName": active.name if active else None,
            "chain": self.turn.get("chain", 0),
            "remaining": self.remaining(),
            "players": [p.to_public() for p in self.players],
            "log": list(self.log[-LOG_LIMIT:]),
        }

    def _private_state(self, player: Player) -> dict[str, Any]:
        items = []
        for item_id in player.items:
            item = items_module.get_item(item_id)
            if item is None:
                continue
            items.append(
                {
                    "id": item["id"],
                    "name": item["name"],
                    "icon": item.get("icon") or "❓",
                    "desc": items_module.describe_item(item),
                }
            )
        return {
            "playerId": player.id,
            "items": items,
            "itemCount": len(player.items),
            "intel": list(player.intel),
            "intelComplete": bool(player.intel) and len(player.intel) == len(self.chamber),
            "mods": {
                "sawnOff": player.sawn_off,
                "nails": player.nails,
                "nailDamage": player.nail_damage,
                "cuffed": player.skips,
            },
            "itemsThisTurn": player.items_this_turn,
        }

    def state_for(self, player_id: str) -> dict[str, Any]:
        player = self.player(player_id)
        public = self._public_state()
        if player is None:
            return {"public": public, "private": {"playerId": player_id, "items": [], "intel": [], "mods": {}}}
        return {"public": public, "private": self._private_state(player)}

    # ------------------------------------------------------------------
    #  日誌
    # ------------------------------------------------------------------
    def _log(self, kind: str, text: str) -> None:
        self._log_id += 1
        self.log.append({"id": self._log_id, "kind": kind, "text": text})
        if len(self.log) > LOG_LIMIT * 2:
            del self.log[: len(self.log) - LOG_LIMIT]


# ---------------------------------------------------------------------------
#  設定取值（都從「這一局的快照」讀，不碰全域設定）
# ---------------------------------------------------------------------------
def _default_config() -> dict[str, Any]:
    from config import game_config

    return game_config.config_snapshot()


def _live_weight_from(config: dict[str, Any], round_number: int) -> float:
    weights = config["AMMO"]["LIVE_WEIGHT"]
    index = max(0, min(len(weights) - 1, int(round_number) - 1))
    return max(0.01, min(0.99, float(weights[index])))


def _item_grant_count_from(config: dict[str, Any], round_number: int) -> int:
    spec = config["AMMO"]["ITEMS_ON_RELOAD"]
    if "min" in spec and "max" in spec:
        return int(spec["min"])
    if int(round_number) >= int(spec["ESCALATE_FROM_ROUND"]):
        return int(spec["ESCALATED"])
    return int(spec["BASE"])


# ---------------------------------------------------------------------------
#  AI
# ---------------------------------------------------------------------------
SELF_SHOT_THRESHOLD = 0.5
MAX_CHAIN = 2


def _known_next_shell(game: Game) -> str | None:
    ai = game.active_player()
    if ai is None:
        return None
    if ai.intel:
        return ai.intel[0]
    if bool(game.config["RULES"].get("AI", {}).get("KNOWS_NEXT_SHELL")):
        return game.chamber[0] if game.chamber else None
    return None


def _live_chance(game: Game) -> float:
    known = _known_next_shell(game)
    if known is not None:
        return 1.0 if known == LIVE else 0.0
    total = game.live + game.blank
    return (game.live / total) if total else 0.5


def choose_ai_intent(game: Game) -> dict[str, Any]:
    """
    AI 的決策：看得懂「剩幾實幾空」、自己的血、手上的道具。
    回傳 {"type": "SHOOT"|"USE_ITEM", "payload": {...}}
    """
    ai = game.active_player()
    if ai is None:
        return {"type": "SHOOT", "payload": {}}

    opponent = game._default_opponent(ai)  # noqa: SLF001 - 同模組內合作
    known = _known_next_shell(game)
    p_live = _live_chance(game)
    chain = game.turn.get("chain", 0)
    last_shell = len(game.chamber) <= 1

    items = list(ai.items)
    has = lambda item_id: item_id in items  # noqa: E731

    # 1. 快死了 → 先補血
    if ai.hp <= 1 and ai.hp < ai.max_hp:
        for heal_id in ("FIRST_AID", "CIGARETTES", "CIGARETTE", "PILLS"):
            if has(heal_id):
                return {"type": "USE_ITEM", "payload": {"item_id": heal_id}}

    # 2. 確定是實彈 → 先用增益，再打敵人
    if known == LIVE:
        if has("HANDSAW") and opponent is not None and opponent.hp > 1:
            return {"type": "USE_ITEM", "payload": {"item_id": "HANDSAW"}}
        if has("INVERTER") and opponent is not None and opponent.hp > 2:
            # 逆轉成空包，然後打自己保留回合（會變成空包）
            return {"type": "USE_ITEM", "payload": {"item_id": "INVERTER"}}
        return {"type": "SHOOT", "payload": {"target_id": opponent.id if opponent else None}}

    # 3. 確定是空包 → 對自己開槍（保留回合），但不包括最後一發
    if known == BLANK:
        if chain < MAX_CHAIN and not last_shell:
            return {"type": "SHOOT", "payload": {"target_id": None}}
        if has("BURNER"):
            return {"type": "USE_ITEM", "payload": {"item_id": "BURNER"}}
        return {"type": "SHOOT", "payload": {"target_id": opponent.id if opponent else None}}

    # 4. 不知道是什麼 → 用資訊類道具換確定性
    if has("MANGLER"):
        return {"type": "USE_ITEM", "payload": {"item_id": "MANGLER"}}
    if has("CHAMPAGNE") and len(game.chamber) >= 2:
        return {"type": "USE_ITEM", "payload": {"item_id": "CHAMPAGNE"}}

    # 5. 健康的時候可以銬一下對手
    if has("HANDCUFFS") and opponent is not None and opponent.skips == 0 and p_live > 0.3:
        return {"type": "USE_ITEM", "payload": {"item_id": "HANDCUFFS", "target_id": opponent.id}}

    # 6. 基本盤：實彈機率高就打敵人，低就打自己
    expected_self_damage = p_live * BASE_DAMAGE
    if p_live < SELF_SHOT_THRESHOLD and expected_self_damage < ai.hp * 0.6 and not last_shell:
        return {"type": "SHOOT", "payload": {"target_id": None}}
    return {"type": "SHOOT", "payload": {"target_id": opponent.id if opponent else None}}


def ai_think_delay(game: Game) -> float:
    cfg = game.config["RULES"].get("AI", {}).get("THINK_DELAY_MS") or {}
    low = float(cfg.get("min", 700))
    high = float(cfg.get("max", 1600))
    if high < low:
        low, high = high, low
    return game.rng.uniform(low, high) / 1000.0


__all__ = ["Game", "Player", "choose_ai_intent", "ai_think_delay", "LIVE", "BLANK", "ERRORS"]
