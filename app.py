""" ==========================================================================
  app.py —— 惡魔輪盤《DEVIL ROULETTE》伺服器入口
  Flask（靜態網頁） + Flask-SocketIO（即時通訊）
 ==========================================================================

  啟動
  ----
      pip install -r requirements.txt
      python app.py                      # http://localhost:5000
      PORT=8000 python app.py            # 換埠
      DEVIL_REVEAL_MS=1500 python app.py # 開局彈藥提示縮短成 1.5 秒（測試用）
      DEVIL_REVEAL_MS=0    python app.py # 完全關掉裝填鎖（自動化測試用）

  安全模型（極重要）
  -----------------
  前端只被允許送「意圖」，永遠不能送「結果」：
      ✔ {"targetId": "p2"}        → 我要對誰開槍
      ✘ {"damage": 3, "shell": "LIVE"} → 這種欄位一律忽略

  玩家身分不從封包裡拿，而是從 Socket 連線本身反查（SID → Seat）。
  子彈順序、剩餘血量、誰的回合，全部由 logic/game_engine.py 這個唯一權威決定；
  前端能看到的東西只有 game.state_for(player_id) 產出的 public / private 兩塊，
  而且 public 裡永遠不會有 chamber（子彈陣列）。

  與 game_engine 的介面契約（下一步會建立 logic/game_engine.py 來實作）
  ----------------------------------------------------------------
      Game.create(room_code: str, seats: list[dict], config: dict | None = None) -> Game
          seats = [{"id": "p1", "name": "你", "is_ai": False}, ...]
      game.start() -> list[dict]                   # 開局動作串（含 AMMO_REVEAL）
      game.execute(player_id, intent, payload) -> dict
          intent: "SHOOT" | "USE_ITEM" | "GUARD" | "TIMEOUT"
          回 {"ok": True, "actions": [...]} 或 {"ok": False, "error": "錯誤碼"}
      game.state_for(player_id) -> {"public": {...}, "private": {...}}
      game.reveal_remaining_ms() -> int            # >0 表示裝填鎖還沒結束
      game.release_reveal() -> list[dict]          # 時間到，解鎖並回動作串
      game.reveal_chamber() -> list[str] | None    # 只有 gameover 才有值
      game.active_id / game.phase / game.version / game.winner_id / game.round
      game.player(pid) -> Player | None            # .id .name .is_ai .dead .hp
      game.active_player() -> Player | None
      game.is_ai_turn() -> bool

      choose_ai_intent(game) -> {"type": "SHOOT"|"USE_ITEM", "payload": {...}}
      ai_think_delay(game) -> float                # 秒
 ========================================================================== """

from __future__ import annotations

# --- 非同步後端：優先 eventlet，裝不起來就退回 threading ---------------------
ASYNC_MODE = "threading"

import os
import random
import string
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any

# Windows 主控台預設是 cp950 / cp936：印出「♠」這類字元會直接 UnicodeEncodeError，
# 伺服器連啟動都失敗。這裡把輸出改成 UTF-8，環境不支援就退回 replace。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except (AttributeError, ValueError):  # pragma: no cover - 非互動環境
        pass

from flask import Flask, jsonify, send_from_directory
from flask_socketio import SocketIO, emit

from config import game_config
from config.game_config import RULES, TIMING
from logic.game_engine import Game, ai_think_delay, choose_ai_intent

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

# ---------------------------------------------------------------------------
#  Flask / Socket.IO
# ---------------------------------------------------------------------------
app = Flask(__name__, static_folder=PUBLIC_DIR, static_url_path="")
app.config["SECRET_KEY"] = os.environ.get("DEVIL_SECRET") or os.urandom(24).hex()
app.config["JSON_AS_ASCII"] = False

socketio = SocketIO(
    app,
    async_mode=ASYNC_MODE,
    cors_allowed_origins="*",
    ping_interval=20,
    ping_timeout=25,
    logger=False,
    engineio_logger=False,
)

# ---------------------------------------------------------------------------
#  常數
# ---------------------------------------------------------------------------
ROOM_CODE_LENGTH = int(TIMING.get("ROOM_CODE_LENGTH", 4))
ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 去掉 I/O/0/1 避免看錯
MAX_ROOMS = 200
ACTION_COOLDOWN_MS = int(TIMING.get("ACTION_COOLDOWN_MS", 120))
# 同一位玩家的同類型請求（開槍 / 用道具）在這個時間內只認第一次，第二次直接丟掉
ACTION_DEDUPE_MS = int(TIMING.get("ACTION_DEDUPE_MS", 500))
# 房主可選的人數：1 人＝單人對 AI（房主 + 自動補的 AI），2~4 人＝真實玩家數
SEAT_LIMITS = [1, 2, 3, 4]
MAX_HUMANS = int(RULES.get("MAX_PLAYERS", 4))
AI_MAX_STEPS_PER_TURN = 8

# ---------------------------------------------------------------------------
#  房況資料
# ---------------------------------------------------------------------------


@dataclass
class Seat:

    id: str
    name: str
    is_ai: bool = False
    sid: str | None = None          # 人類才有；AI 恆為 None
    connected: bool = True
    ready: bool = False             # 用來決定 rematch 是否可以開新局
    last_action_at: float = 0.0
    # 防連點：每種請求各記一個時間戳（"SHOOT" / "USE_ITEM"），互不干擾
    action_stamps: dict[str, float] = field(default_factory=dict)

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "isAI": self.is_ai,
            "connected": self.connected,
            "ready": self.ready,
        }


@dataclass
class Room:
    code: str
    host_id: str
    seats: list[Seat] = field(default_factory=list)
    game: Game | None = None
    # 房主選的人數上限：1 = 單人對 AI（房主 + 自動補的 AI），2~4 = 真實玩家數
    max_players: int = 0
    created_at: float = field(default_factory=time.time)
    turn_deadline: float = 0.0      # epoch 秒；0 = 目前沒有計時
    reveal_until: float = 0.0       # epoch 秒；前端用來畫進度條
    reveal_ms: int = 0
    generation: int = 0             # 每次開新局 +1，讓舊的計時器自動失效
    empty_since: float = 0.0        # 最後一個人離線的時間（0 = 有人）
    lock: threading.RLock = field(default_factory=threading.RLock)

    # --- 座位查詢 ---------------------------------------------------------
    def seat(self, seat_id: str | None) -> Seat | None:
        if not seat_id:
            return None
        for s in self.seats:
            if s.id == seat_id:
                return s
        return None

    def seat_by_sid(self, sid: str | None) -> Seat | None:
        if not sid:
            return None
        for s in self.seats:
            if s.sid == sid:
                return s
        return None

    def humans(self) -> list[Seat]:
        return [s for s in self.seats if not s.is_ai]

    def ai_seat(self) -> Seat | None:
        for s in self.seats:
            if s.is_ai:
                return s
        return None

    def in_game(self) -> bool:
        return self.game is not None and self.game.phase == "playing"

    # --- 人數上限 ---------------------------------------------------------
    @property
    def human_limit(self) -> int:
        """還允許幾位「真實玩家」進來（AI 不佔用名額）。"""
        return self.max_players if self.max_players > 0 else MAX_HUMANS

    def connected_humans(self) -> int:
        return len([s for s in self.seats if not s.is_ai and s.connected])

    def joined_humans(self) -> int:
        """已佔用的真人座位（含斷線等重連的），判斷房間滿不滿看這個。"""
        return len(self.humans())

    def is_full(self) -> bool:
        return self.joined_humans() >= self.human_limit


ROOMS: dict[str, Room] = {}
SID_ROOM: dict[str, str] = {}
STATE_LOCK = threading.RLock()


# ---------------------------------------------------------------------------
#  小工具
# ---------------------------------------------------------------------------
def new_seat_id(room: Room) -> str:
    index = 1
    used = {s.id for s in room.seats}
    while f"p{index}" in used:
        index += 1
    return f"p{index}"


def generate_room_code() -> str:
    for _ in range(500):
        code = "".join(random.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH))
        if code not in ROOMS:
            return code
    return "".join(random.choice(ROOM_CODE_ALPHABET) for _ in range(6))


def pick_ai_name(room: Room) -> str:
    used = {s.name for s in room.seats}
    for name in RULES.get("ENEMY_NAMES", ["DeepSeek 娘"]):
        if name not in used:
            return name
    return f"DeepSeek 娘 {len(room.seats)}"


def now_ms() -> int:
    return int(time.time() * 1000)


def safe_name(raw: Any, fallback: str) -> str:
    """玩家暱稱：限長度、去控制字元，避免塞爆前端或 log。"""
    text = str(raw or "").strip()
    text = "".join(ch for ch in text if ch.isprintable())
    text = text[:16]
    return text or fallback


def cooldown_ok(seat: Seat) -> bool:
    gap = (time.time() - seat.last_action_at) * 1000
    if gap < ACTION_COOLDOWN_MS:
        return False
    seat.last_action_at = time.time()
    return True


def accept_action(seat: Seat, kind: str) -> bool:
    """防連點 + 防重放的伺服器端閘門。

    同一種請求（"SHOOT" / "USE_ITEM"）在 ACTION_DEDUPE_MS（預設 0.5 秒）內
    只認第一次，第二次直接丟掉（回 TOO_FAST），不會執行動作、也不算失誤。
    前端改 console 或直接重送 socket 封包都繞不過這一關。
    """
    now = time.time()
    stamps = seat.action_stamps
    last = stamps.get(kind, 0.0)
    if (now - last) * 1000 < ACTION_DEDUPE_MS:
        return False
    # 順手把同一輪的舊戳記清掉，避免 dict 無限長大
    for key in [k for k, v in stamps.items() if (now - v) * 1000 > 60_000]:
        stamps.pop(key, None)
    stamps[kind] = now
    seat.last_action_at = now
    return True


def sanitize_payload(data: Any, allowed: tuple[str, ...]) -> dict[str, Any]:
    """只保留白名單欄位，其他一律丟掉（damage / hp / shell / chamber … 都不會進到引擎）。

    這是「不相信前端」的第一道門：就算有人用 devtools 或直接送 socket 封包
    塞了 {"damage": 99, "hp": 0}，這裡也只會留下 targetId / itemId。
    """
    if not isinstance(data, dict):
        return {}
    clean: dict[str, Any] = {}
    for key in allowed:
        if key in data:
            value = data[key]
            # 只接受字串或 None；數字 / 物件 / 陣列一律視為沒帶
            if isinstance(value, str):
                clean[key] = value.strip()[:64]
            elif value is None:
                clean[key] = None
    return clean


def normalize_max_players(raw: Any) -> int:
    """把前端傳來的 max_players 夾到合法範圍（1~4）；看不懂就回預設值。"""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = SEAT_LIMITS[-1]
    if value not in SEAT_LIMITS:
        value = max(SEAT_LIMITS[0], min(SEAT_LIMITS[-1], value))
    return value


# ---------------------------------------------------------------------------
#  廣播
# ---------------------------------------------------------------------------
SECRET_ACTION_KEYS = {"chamber", "shells", "intel", "pending", "secret", "deck"}


def redact_action(action: dict[str, Any]) -> dict[str, Any]:
    """把動作裡可能洩漏子彈順序的欄位拿掉，再送給所有玩家。"""
    if not isinstance(action, dict):
        return action
    return {k: v for k, v in action.items() if k not in SECRET_ACTION_KEYS}


def broadcast_actions(room: Room, actions: list[dict[str, Any]] | None) -> None:
    """把引擎產生的動作串送給房裡所有人（已過濾機密欄位）。"""
    if not actions:
        return
    payload = {"code": room.code, "actions": [redact_action(a) for a in actions]}
    socketio.emit("game:action", payload, to=room.code)


def sync_reveal_clock(room: Room) -> None:
    """
    把「裝填鎖剩餘時間」從引擎同步到房間物件。

    為什麼需要：開局時動作先廣播、計時器後才 arm，此時 room.reveal_until 還是 0，
    前端會看到 revealUntil=0 而誤以為可以行動（伺服器仍會擋，但體驗很差）。
    """
    game = room.game
    if game is None:
        room.reveal_until = 0.0
        room.reveal_ms = 0
        return
    remaining = game.reveal_remaining_ms()
    if remaining <= 0:
        room.reveal_until = 0.0
        room.reveal_ms = 0
    else:
        room.reveal_until = time.time() + remaining / 1000.0
        room.reveal_ms = remaining


def emit_state(room: Room) -> None:
    """為每位人類玩家各自送一份「他看得到的狀態」。"""
    game = room.game
    if game is None:
        return
    sync_reveal_clock(room)
    for seat in room.humans():
        if not seat.sid or not seat.connected:
            continue
        try:
            state = game.state_for(seat.id)
        except Exception:  # noqa: BLE001 - 單一玩家失敗不該拖垮整房
            continue
        socketio.emit(
            "room:update",
            {
                "code": room.code,
                "hostId": room.host_id,
                # 每個人都會收到「自己在這場遊戲裡是哪個 id」：
                # 前端不必再猜，重新整理後也能立刻認回自己的座位。
                "youId": seat.id,
                "seats": [s.to_public() for s in room.seats],
                "game": state,
                "revealUntil": int(room.reveal_until * 1000) if room.reveal_until else 0,
                "revealMs": room.reveal_ms,
                "serverNow": now_ms(),
                "turnDeadline": int(room.turn_deadline * 1000) if room.turn_deadline else 0,
            },
            to=seat.sid,
        )


def emit_lobby(room: Room) -> None:
    socketio.emit(
        "lobby:update",
        {
            "code": room.code,
            "hostId": room.host_id,
            "seats": [s.to_public() for s in room.seats],
            "inGame": room.in_game(),
            # 大廳要顯示「2 / 4 人」與「人數已滿」
            "maxPlayers": room.max_players,
            "humanLimit": room.human_limit,
            "joined": room.joined_humans(),
            "full": room.is_full(),
        },
        to=room.code,
    )


def send_error(sid: str | None, code: str) -> None:
    if sid:
        socketio.emit("game:error", {"error": code}, to=sid)


# ---------------------------------------------------------------------------
#  計時器：裝填鎖 / 回合逾時 / AI
# ---------------------------------------------------------------------------
def clear_timers(room: Room) -> None:
    room.turn_deadline = 0.0
    room.reveal_until = 0.0
    room.reveal_ms = 0


def arm_reveal_timer(room: Room) -> bool:
    """
    若引擎說「還在裝填鎖」，就開一個背景任務，時間到自動解鎖並廣播。
    回傳 True 表示目前被鎖住（呼叫端應該停止後續排程）。
    """
    game = room.game
    if game is None:
        return False
    remaining = game.reveal_remaining_ms()
    if remaining <= 0:
        return False

    room.reveal_ms = remaining
    room.reveal_until = time.time() + remaining / 1000.0
    generation = room.generation

    def worker() -> None:
        # 睡到鎖「真的」結束為止。socketio.sleep 常常提早幾毫秒醒來，
        # 那時 reveal_remaining_ms() 還是 > 0 —— 如果直接 return，鎖就永遠不會解開，
        # 整場遊戲會卡死在 AMMO_REVEAL。所以這裡一定要重試。
        while True:
            left = game.reveal_remaining_ms()
            if left <= 0:
                break
            if room.generation != generation or room.game is not game:
                return
            socketio.sleep(min(left, 250) / 1000.0 + 0.01)

        if room.generation != generation or room.game is not game:
            return
        with room.lock:
            if room.game is not game:
                return
            room.reveal_until = 0.0
            room.reveal_ms = 0
            actions = game.release_reveal()
        broadcast_actions(room, actions)
        emit_state(room)  # 鎖解開後一定要補推一份狀態，否則前端還以為在鎖住
        schedule_after_broadcast(room)

    socketio.start_background_task(worker)
    return True


def arm_turn_timer(room: Room) -> None:
    """人類玩家太久沒動作 → 伺服器代打（自射一下，跟斷線處理一致）。"""
    game = room.game
    if game is None or game.phase != "playing":
        room.turn_deadline = 0.0
        return
    active = game.active_player()
    if active is None or active.is_ai:
        room.turn_deadline = 0.0
        return

    timeout_ms = int(RULES.get("TURN_TIMEOUT_MS", 60000))
    seat = room.seat(active.id)
    if seat is not None and not seat.connected:
        # 人已經跑了 → 不用等滿 60 秒，用重連寬限期縮短卡住的時間
        timeout_ms = int(TIMING.get("RECONNECT_GRACE_MS", 15000))
    room.turn_deadline = time.time() + timeout_ms / 1000.0
    generation = room.generation
    active_id = active.id
    version = game.version

    def worker() -> None:
        socketio.sleep(timeout_ms / 1000.0)
        with room.lock:
            if room.generation != generation or room.game is not game:
                return
            if game.phase != "playing" or game.active_id != active_id or game.version != version:
                return
            result = game.execute(active_id, "TIMEOUT", {"target_id": None})
        if result.get("ok"):
            room.turn_deadline = 0.0
            broadcast_actions(room, result.get("actions"))
            emit_state(room)
            schedule_after_broadcast(room)

    socketio.start_background_task(worker)


def run_ai_loop(room: Room) -> None:
    """AI 回合：一步一步問引擎，直到回合交還給人類或遊戲結束。"""
    game = room.game
    if game is None:
        return
    generation = room.generation

    for _ in range(AI_MAX_STEPS_PER_TURN):
        if room.generation != generation or room.game is not game:
            return
        if game.phase != "playing":
            return
        active = game.active_player()
        if active is None or not active.is_ai:
            return

        socketio.sleep(ai_think_delay(game))
        with room.lock:
            if room.game is not game or game.phase != "playing":
                return
            current = game.active_player()
            if current is None or not current.is_ai:
                return
            intent = choose_ai_intent(game)
            result = game.execute(current.id, intent.get("type"), intent.get("payload") or {})

        if not result.get("ok"):
            # AI 想做的事不合法（例如道具被換掉）→ 改成對玩家開槍，絕不卡住
            fallback_targets = [s.id for s in room.humans() if not _is_dead(game, s.id)]
            payload = {"target_id": fallback_targets[0] if fallback_targets else None}
            with room.lock:
                result = game.execute(current.id, "SHOOT", payload)
            if not result.get("ok"):
                return

        broadcast_actions(room, result.get("actions"))
        emit_state(room)

    schedule_after_broadcast(room)


def _is_dead(game: Game, player_id: str) -> bool:
    player = game.player(player_id)
    return bool(player is None or getattr(player, "dead", False))


def schedule_after_broadcast(room: Room) -> None:
    """
    一次廣播之後該做的事：
      1. 裝填鎖還沒結束 → 等它結束（期間誰都不能動）
      2. 遊戲結束 → 公布最終子彈
      3. 輪到 AI → 排 AI 行動
      4. 輪到人類 → 開回合計時器
    """
    game = room.game
    if game is None:
        clear_timers(room)
        return

    if game.phase == "gameover":
        clear_timers(room)
        chamber = game.reveal_chamber() or []
        socketio.emit(
            "game:reveal",
            {"code": room.code, "chamber": chamber, "winnerId": game.winner_id},
            to=room.code,
        )
        return

    if game.phase != "playing":
        clear_timers(room)
        return

    if arm_reveal_timer(room):
        return

    # 計時器要在「廣播之後」馬上設好，否則客戶端收到的這份狀態裡 turnDeadline 是舊的（0），
    # 得等下一次推播才會看到倒數。這裡先算好期限，再補推一份新狀態。
    active = game.active_player()
    if active is not None and active.is_ai:
        room.turn_deadline = 0.0
        socketio.start_background_task(run_ai_loop, room)
        return

    arm_turn_timer(room)
    if room.turn_deadline:
        emit_state(room)


# ---------------------------------------------------------------------------
#  HTTP 路由
# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "rooms": len(ROOMS), "asyncMode": ASYNC_MODE, "version": game_config.VERSION})


@app.get("/api/config")
def api_config():
    return jsonify(game_config.get_client_config())


# ---------------------------------------------------------------------------
#  連線事件
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    emit("server:hello", {"config": game_config.get_client_config(), "asyncMode": ASYNC_MODE})


@socketio.on("disconnect")
def on_disconnect():
    from flask import request

    sid = request.sid
    with STATE_LOCK:
        code = SID_ROOM.pop(sid, None)
        room = ROOMS.get(code) if code else None
        seat = room.seat_by_sid(sid) if room else None
        if seat is not None:
            seat.sid = None
            seat.connected = False
            seat.ready = False
        if room is not None:
            # 房主離開 → 交給下一位還在線的人類
            if room.host_id == (seat.id if seat else None):
                online = [s for s in room.humans() if s.connected]
                if online:
                    room.host_id = online[0].id
            if not [s for s in room.humans() if s.connected]:
                # 不要立刻砍房間！按一下 F5 也會走到這裡，
                # 砍掉的話重新整理後就只剩「等待開局…」和灰按鈕。
                room.empty_since = time.time()
                empty = True
            else:
                room.empty_since = 0.0
                empty = False
        else:
            empty = False
    if room is not None:
        if empty:
            schedule_room_cleanup(room)
        else:
            emit_state(room)
            emit_lobby(room)


def schedule_room_cleanup(room: Room) -> None:
    """房間沒人時先留著，等重連寬限期過了才真的刪掉。"""
    grace_ms = float(TIMING.get("RECONNECT_GRACE_MS", 15000))
    if room.ai_seat() is not None:
        # 單人局（有 AI）：重新整理很常見，留久一點
        grace_ms = max(grace_ms, 120000.0)

    def worker() -> None:
        socketio.sleep(grace_ms / 1000.0)
        with STATE_LOCK:
            live = [s for s in room.humans() if s.connected]
            if live:
                return
            if room.empty_since <= 0:
                return
            ROOMS.pop(room.code, None)
            for s in room.seats:
                if s.sid:
                    SID_ROOM.pop(s.sid, None)

    socketio.start_background_task(worker)


# ---------------------------------------------------------------------------
#  房間事件
# ---------------------------------------------------------------------------
def room_of(sid: str) -> Room | None:
    code = SID_ROOM.get(sid)
    return ROOMS.get(code) if code else None


def seat_of(sid: str) -> tuple[Room | None, Seat | None]:
    room = room_of(sid)
    if room is None:
        return None, None
    return room, room.seat_by_sid(sid)


def reattach(room: Room, seat: Seat, sid: str) -> None:
    """把新連線（例如重新整理頁面後的新 sid）接回原本的座位。"""
    old_sid = seat.sid
    if old_sid and old_sid != sid:
        SID_ROOM.pop(old_sid, None)
    seat.sid = sid
    seat.connected = True
    seat.ready = False
    room.empty_since = 0.0
    SID_ROOM[sid] = room.code
    socketio.server.enter_room(sid, room.code)
    # 房主回來時把房主還給他（若目前沒有在線的房主）
    hosts = [s for s in room.humans() if s.connected and s.id == room.host_id]
    if not hosts:
        room.host_id = seat.id


@socketio.on("room:rejoin")
def on_room_rejoin(data=None):
    """
    重新整理 / 斷線重連：用「房碼 + 名字」把新 sid 接回舊座位。

    沒有這條路徑時，F5 之後的連線是一個全新訪客，
    伺服器不會再推 room:update，前端就會永遠停在「等待開局…」、按鈕全灰。
    """
    from flask import request

    data = data or {}
    sid = request.sid
    code = str(data.get("code") or "").strip().upper()
    name = safe_name(data.get("name"), "")

    with STATE_LOCK:
        room = ROOMS.get(code)
        if room is None:
            return {"ok": False, "error": "ROOM_NOT_FOUND"}
        seat = None
        if name:
            for candidate in room.seats:
                if candidate.is_ai or candidate.connected:
                    continue
                if candidate.name == name:
                    seat = candidate
                    break
        if seat is None:
            # 名字對不上時，若這個 sid 本來就在房裡就直接用
            seat = room.seat_by_sid(sid)
        if seat is None:
            return {"ok": False, "error": "SEAT_NOT_FOUND"}

        reattach(room, seat, sid)
        game = room.game

    if game is not None:
        emit_state(room)
        if room.reveal_until and game.phase == "playing":
            schedule_after_broadcast(room)
    emit_lobby(room)
    return {"ok": True, "code": room.code, "youId": seat.id, "hostId": room.host_id}


@socketio.on("room:create")
def on_room_create(data=None):
    from flask import request

    data = data or {}
    sid = request.sid
    with STATE_LOCK:
        if len(ROOMS) >= MAX_ROOMS:
            return {"ok": False, "error": "SERVER_FULL"}
        if sid in SID_ROOM:
            return {"ok": False, "error": "ALREADY_IN_ROOM"}

        code = generate_room_code()
        room = Room(code=code, host_id="p1")
        # 房主在大廳選的人數上限（1 = 單人對 AI）
        room.max_players = normalize_max_players(data.get("maxPlayers", data.get("max_players")))
        name = safe_name(data.get("name"), "玩家")
        room.seats.append(Seat(id="p1", name=name, sid=sid))
        ROOMS[code] = room
        SID_ROOM[sid] = code

    socketio.server.enter_room(sid, code)
    emit_state(room) if room.game else None
    emit_lobby(room)
    return {
        "ok": True,
        "code": code,
        "youId": "p1",
        "hostId": room.host_id,
        "maxPlayers": room.max_players,
    }


@socketio.on("room:join")
def on_room_join(data=None):
    from flask import request

    data = data or {}
    sid = request.sid
    code = str(data.get("code") or "").strip().upper()
    with STATE_LOCK:
        room = ROOMS.get(code)
        if room is None:
            return {"ok": False, "error": "ROOM_NOT_FOUND"}
        if sid in SID_ROOM:
            return {"ok": False, "error": "ALREADY_IN_ROOM"}

        wanted = safe_name(data.get("name"), "")
        # 同名且已斷線的座位 → 當成重連，直接接回去（遊戲中也可以）
        reclaimed = None
        if wanted:
            for candidate in room.seats:
                if candidate.is_ai or candidate.connected:
                    continue
                if candidate.name == wanted:
                    reclaimed = candidate
                    break
        if reclaimed is not None:
            reattach(room, reclaimed, sid)
            seat = reclaimed
            game = room.game
        else:
            game = None
            # 人數上限由房主決定（1 = 只有房主一個人 + 自動補的 AI）
            if room.is_full():
                return {"ok": False, "error": "ROOM_FULL"}
            if room.in_game():
                return {"ok": False, "error": "GAME_ALREADY_STARTED"}

            name = safe_name(data.get("name"), f"玩家 {len(room.seats) + 1}")
            if any(s.name == name for s in room.seats):
                name = f"{name}2"

            seat = Seat(id=new_seat_id(room), name=name, sid=sid)
            room.seats.append(seat)
            SID_ROOM[sid] = code

    if game is None:
        socketio.server.enter_room(sid, code)
    emit_state(room) if room.game else None
    emit_lobby(room)
    if game is not None and room.reveal_until and game.phase == "playing":
        schedule_after_broadcast(room)
    return {"ok": True, "code": code, "youId": seat.id, "hostId": room.host_id}


@socketio.on("room:leave")
def on_room_leave(data=None):
    from flask import request

    sid = request.sid
    code = SID_ROOM.pop(sid, None)
    if not code:
        return {"ok": True}
    room = ROOMS.get(code)
    if room is None:
        return {"ok": True}

    with room.lock:
        seat = room.seat_by_sid(sid)
        if seat is not None and not room.in_game():
            room.seats = [s for s in room.seats if s.id != seat.id]
        elif seat is not None:
            seat.sid = None
            seat.connected = False
        if not [s for s in room.humans() if s.connected]:
            ROOMS.pop(room.code, None)
            return {"ok": True}
        if room.host_id == (seat.id if seat else None):
            online = [s for s in room.humans() if s.connected]
            if online:
                room.host_id = online[0].id

    socketio.server.leave_room(sid, code)
    emit_state(room)
    emit_lobby(room)
    schedule_after_broadcast(room)
    return {"ok": True}


# ---------------------------------------------------------------------------
#  開局
# ---------------------------------------------------------------------------
def add_ai_if_needed(room: Room) -> None:
    """房的真人數不足 2 人時自動補一位 AI，名字優先取「DeepSeek 娘」。

    房主選「1 人」就是單人對 AI；選 2~4 人但只有自己一個人開局時，
    也一樣補 AI 讓局面能跑（不會卡在 NOT_ENOUGH_PLAYERS）。
    """
    if len(room.seats) >= 2:
        return
    if RULES.get("HUMAN_ONLY"):
        return
    if not RULES.get("AI", {}).get("ENABLED", True):
        return
    room.seats.append(Seat(id="ai1", name=pick_ai_name(room), is_ai=True, connected=True))


def start_game(room: Room, by_seat: Seat | None) -> dict[str, Any]:
    if by_seat is None or by_seat.id != room.host_id:
        return {"ok": False, "error": "NOT_HOST"}
    if room.in_game():
        return {"ok": False, "error": "ALREADY_STARTED"}
    if len(room.humans()) < int(RULES.get("MIN_PLAYERS", 1)):
        return {"ok": False, "error": "NOT_ENOUGH_PLAYERS"}

    add_ai_if_needed(room)
    if len(room.seats) < 2:
        return {"ok": False, "error": "NOT_ENOUGH_PLAYERS"}

    with room.lock:
        # 大廳期間斷線的人不該被帶進遊戲（否則會有一個永遠不動的「鬼座位」卡住回合）
        room.seats = [s for s in room.seats if s.is_ai or s.connected]
        if len(room.seats) < 2:
            return {"ok": False, "error": "NOT_ENOUGH_PLAYERS"}
        room.generation += 1
        clear_timers(room)
        seats = [
            {"id": s.id, "name": s.name, "is_ai": s.is_ai}
            for s in room.seats
        ]
        room.game = Game.create(room.code, seats, config=game_config.config_snapshot())
        actions = room.game.start()
        for s in room.seats:
            s.ready = False

    broadcast_actions(room, actions)
    emit_state(room)
    emit_lobby(room)
    schedule_after_broadcast(room)
    return {"ok": True}


@socketio.on("game:start")
def on_game_start(_data=None):
    from flask import request

    room, seat = seat_of(request.sid)
    if room is None:
        return {"ok": False, "error": "NOT_IN_ROOM"}
    return start_game(room, seat)


@socketio.on("room:rematch")
def on_rematch(_data=None):
    """全部在線的人類都按了「再來一局」才重新開局。"""
    from flask import request

    room, seat = seat_of(request.sid)
    if room is None:
        return {"ok": False, "error": "NOT_IN_ROOM"}

    with room.lock:
        if seat is not None:
            seat.ready = True
        humans = room.humans()
        everyone_ready = all(s.ready for s in humans if s.connected)

    if not everyone_ready:
        emit_lobby(room)
        return {"ok": True, "waiting": True}

    # 只留人類座位，AI 於開局時重新補上
    with room.lock:
        room.seats = [s for s in room.seats if not s.is_ai]
        room.game = None
        for s in room.seats:
            s.ready = False
    emit_lobby(room)
    return start_game(room, room.seat_by_sid(request.sid))


# ---------------------------------------------------------------------------
#  遊戲中：開槍 / 用道具（所有驗證都在伺服器）
# ---------------------------------------------------------------------------
def validate_target(game: Game, target_id: Any) -> str | None:
    """target_id 只接受「房間裡存在且還活著的人」；其餘一律視為打自己。"""
    if target_id in (None, "", "self"):
        return None
    if not isinstance(target_id, str):
        return None
    player = game.player(target_id)
    if player is None or getattr(player, "dead", False):
        return None
    return target_id


@socketio.on("game:shoot")
def on_shoot(data=None):
    from flask import request

    room, seat = seat_of(request.sid)
    if room is None or seat is None:
        return {"ok": False, "error": "NOT_IN_ROOM"}

    # ── 防作弊 1：前端只准送 targetId，其他欄位（damage / hp / shell…）一律不看 ──
    payload_in = sanitize_payload(data, allowed=("targetId", "target_id"))
    game = room.game
    if game is None or game.phase != "playing":
        return {"ok": False, "error": "GAME_NOT_PLAYING"}
    if seat.is_ai:
        return {"ok": False, "error": "NOT_A_PLAYER"}

    # ── 防作弊 2：0.5 秒內的第二發直接忽略（不執行、不回動作） ──
    if not accept_action(seat, "SHOOT"):
        return {"ok": False, "error": "TOO_FAST"}

    # ── 防作弊 3：目標只接受「房間裡存在且活著的人」，其餘一律當成打自己 ──
    target_id = validate_target(game, payload_in.get("targetId", payload_in.get("target_id")))

    with room.lock:
        result = game.execute(seat.id, "SHOOT", {"target_id": target_id})

    if not result.get("ok"):
        return {"ok": False, "error": result.get("error", "UNKNOWN")}

    room.turn_deadline = 0.0
    broadcast_actions(room, result.get("actions"))
    emit_state(room)
    schedule_after_broadcast(room)
    return {"ok": True}


@socketio.on("game:item")
def on_use_item(data=None):
    from flask import request

    room, seat = seat_of(request.sid)
    if room is None or seat is None:
        return {"ok": False, "error": "NOT_IN_ROOM"}

    # ── 只接受 itemId / targetId，其餘欄位全部丟掉 ──
    payload_in = sanitize_payload(data, allowed=("itemId", "item_id", "targetId", "target_id"))
    game = room.game
    if game is None or game.phase != "playing":
        return {"ok": False, "error": "GAME_NOT_PLAYING"}
    if seat.is_ai:
        return {"ok": False, "error": "NOT_A_PLAYER"}

    if not accept_action(seat, "USE_ITEM"):
        return {"ok": False, "error": "TOO_FAST"}

    raw_item = payload_in.get("itemId", payload_in.get("item_id"))
    # 道具 id 只收「字母數字加底線」的短字串，防止塞長字串或奇怪字元
    if not isinstance(raw_item, str) or not raw_item or len(raw_item) > 32:
        return {"ok": False, "error": "BAD_ITEM"}
    item_id = raw_item.upper()

    # 只傳「道具 id」與「目標」，庫存、血量、傷害、效果全部由引擎自己算
    payload: dict[str, Any] = {"item_id": item_id}
    target_id = validate_target(game, payload_in.get("targetId", payload_in.get("target_id")))
    if target_id:
        payload["target_id"] = target_id

    with room.lock:
        result = game.execute(seat.id, "USE_ITEM", payload)

    if not result.get("ok"):
        return {"ok": False, "error": result.get("error", "UNKNOWN")}

    room.turn_deadline = 0.0
    broadcast_actions(room, result.get("actions"))
    emit_state(room)
    schedule_after_broadcast(room)
    return {"ok": True}


# ---------------------------------------------------------------------------
#  啟動
# ---------------------------------------------------------------------------
def main() -> None:
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "0.0.0.0")
    print("=" * 62)
    print("  ♠ 惡魔輪盤 DEVIL ROULETTE —— Flask + Socket.IO")
    print(f"  版本      : {game_config.VERSION}")
    print(f"  非同步模式: {ASYNC_MODE}")
    print(f"  網址      : http://localhost:{port}")
    if game_config.APPLIED_ENV_OVERRIDES:
        print(f"  環境覆寫  : {', '.join(game_config.APPLIED_ENV_OVERRIDES)}")
    print("=" * 62)
    socketio.run(app, host=host, port=port, debug=False, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()
