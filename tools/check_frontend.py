"""
前端接縫檢查（純標準庫，不需要跑伺服器）

用途：確認 index.html 真的有關鍵元素、而且 client.js 用到的每個 id 都存在。
少了任何一個 id，client.js 在渲染時就會丟 TypeError，
畫面會停在「等待開局…」而且按鈕全灰 —— 這個檔案就是防這個。

同時確認「已移除」的東西真的不見了：彈藥數量 chips 與歷史日誌。

用法：
    python tools/check_frontend.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

# Windows 的主控台常是 cp950/cp936，直接印中文＋表情符號會炸，先轉成 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover - 舊版 Python 或非 TTY
    pass

# 沒有這些元素，舞台就演不下去（id → 說明）
REQUIRED_IDS = {
    "lobby": "大廳畫面",
    "game": "遊戲畫面",
    "nameInput": "名字輸入框",
    "btnSolo": "單人開局",
    "btnCreate": "建立房間",
    "btnJoin": "加入房間",
    "codeInput": "房碼輸入",
    "roundLabel": "輪次",
    "codeLabel": "房碼顯示",
    "opponents": "上半部對手區（1~3 並排）",
    "turnLabel": "現在是誰的回合",
    "gun": "中央散彈槍",
    "bubble": "DeepSeek 娘台詞",
    "hint": "提示文字",
    "me": "下半部自己",
    "myName": "自己的名字",
    "myHearts": "自己的血量",
    "myStatus": "自己的狀態",
    "myIntel": "已知彈藥",
    "itemsGrid": "專屬道具欄",
    "targets": "多對手選擇列",
    "btnSelf": "對自己開槍",
    "btnEnemy": "對敵人開槍",
    "enemySub": "敵人按鈕副標（顯示目標）",
    "startBtn": "開局",
    "quitBtn": "離開",
    "reveal": "開局彈藥提示",
    "revealLive": "提示中的實彈數",
    "revealBlank": "提示中的空包彈數",
    "revealBar": "提示的倒數條",
    "resultTitle": "結算標題",
    "resultText": "結算說明",
    "btnAgain": "再來一局",
    "btnLeave": "回大廳",
}

# 這些是舊版面的東西，必須完全消失（使用者明確要求移除）
REMOVED_IDS = {
    "shellLive": "剩餘實彈數",
    "shellBlank": "剩餘空包彈數",
    "shellTotal": "剩餘子彈總數",
    "log": "歷史日誌面板",
    "logList": "歷史日誌清單",
}

REMOVED_JS = ("renderShells", "renderLogEntries")

CSS_HOOKS = (".foes", ".foe", ".me", ".items", ".slot", ".btn--big", ".turn", ".reveal", ".actions")

ID_RE = re.compile(r'id="([^"]+)"')
CLIENT_ID_RE = re.compile(r'\$\("([^"]+)"\)')


def main() -> int:
    html = (PUBLIC / "index.html").read_text(encoding="utf-8")
    css = (PUBLIC / "style.css").read_text(encoding="utf-8")
    js = (PUBLIC / "client.js").read_text(encoding="utf-8")

    html_ids = set(ID_RE.findall(html))
    used_ids = set(CLIENT_ID_RE.findall(js))

    problems: list[str] = []

    duplicated = [i for i in html_ids if len(re.findall(rf'id="{re.escape(i)}"', html)) > 1]
    if duplicated:
        problems.append("index.html 有重複的 id：" + ", ".join(sorted(duplicated)))

    for needed, why in REQUIRED_IDS.items():
        if needed not in html_ids:
            problems.append(f"index.html 缺少 #{needed}（{why}）")

    for used in sorted(used_ids - html_ids):
        problems.append(f"client.js 用到 #{used}，但 index.html 沒有這個元素")

    for gone, why in REMOVED_IDS.items():
        if gone in html_ids:
            problems.append(f"index.html 還留著 #{gone}（{why}，應該已移除）")
        if f'"{gone}"' in js:
            problems.append(f"client.js 還在用 #{gone}（{why}，應該已移除）")

    for gone in REMOVED_JS:
        if gone in js:
            problems.append(f"client.js 還留著 {gone}()，應該已刪除")

    for hook in CSS_HOOKS:
        if hook not in css:
            problems.append(f"style.css 缺少樣式 {hook}")

    print(f"index.html：{len(html_ids)} 個 id")
    print(f"client.js：用到 {len(used_ids)} 個 id")
    if problems:
        print("\n發現問題：")
        for p in problems:
            print("  ✗", p)
        return 1

    print("前端接縫全部對得上 ✅（彈藥數量與日誌已移除）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
