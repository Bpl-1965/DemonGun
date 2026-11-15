/* ==========================================================================
 *  惡魔輪盤 · 3D 桌面場景（Three.js）
 *  ------------------------------------------------------------------------
 *  這個檔案只負責「看得見的東西」：
 *    - 木桌（BoxGeometry）、兩盞聚光燈、煙霧、桌下地面
 *    - 玩家 = 膠囊體 CapsuleGeometry、惡魔 = 面向鏡頭的 PlaneGeometry（DeepSeek 娘立繪）
 *    - 散彈槍：全部用 BoxGeometry / CylinderGeometry 拼出來的
 *    - 道具凹槽（線框 + 深色方塊），靠近玩家與惡魔兩側各一排
 *    - 槍口火焰 PointLight 閃爍、相機震動、開槍時的後座與彈殼、血濺粒子
 *  規則（血量、回合、子彈）完全由 server 決定，這裡只「畫」，不「算」。
 * ========================================================================== */
'use strict';

(function () {
  const THREE = window.THREE;
  if (!THREE) {
    console.warn('[3D] 沒有載入 Three.js，場景停用。');
    return;
  }

  /* ---------------------------------------------------------------------- */
  /*  0. 設定                                                               */
  /* ---------------------------------------------------------------------- */

  /** 桌面尺寸（單位 = 世界單位，1 ≈ 1 公尺）—— 賭場長桌，四邊各坐一個 */
  const TABLE = { W: 7.0, D: 4.6, H: 0.24, TOP: 0 };
  /**
   * 座位錨點 = 一個橢圓環。
   *   seat 0 永遠是「你」（畫面上方 / 對面），其餘順時鐘排下去；
   *   人數改變時 client.js 會呼叫 setSeats() 重算，座位會平滑滑到新位置。
   */
  const SEAT_INSET = 0.5; // 人離桌邊多遠
  const SEAT_RX = TABLE.W / 2 + SEAT_INSET; // 3.9
  const SEAT_RZ = TABLE.D / 2 + SEAT_INSET; // 2.8
  function seatPoint(frac) {
    // frac = 0 ~ 1：0 = 對面（你的正前方），0.25 = 右側、0.5 = 你這側、0.75 = 左側
    const a = Math.PI * 2 * frac;
    return { x: Math.sin(a) * SEAT_RX, z: -Math.cos(a) * SEAT_RZ };
  }
  /** 名字牌 / 立繪的高度（世界座標 Y） */
  const PLATE_Y = { you: 2.2, other: 1.5, demon: 1.7 };
  /** 槍的停放／持槍位置（槍口永遠朝 -Z，也就是朝向桌面中心） */
  const GUN_POSES = {
    center: { x: 0, y: TABLE.H + 0.16, z: 0.15, yaw: 0.22 },
    you: { x: -0.2, y: TABLE.H + 0.2, z: 0.95, yaw: -0.42 },
    demon: { x: -0.2, y: TABLE.H + 0.2, z: -1.0, yaw: -0.42 },
    left: { x: -2.0, y: TABLE.H + 0.2, z: 0.0, yaw: Math.PI / 2 },
    right: { x: 2.0, y: TABLE.H + 0.2, z: 0.0, yaw: -Math.PI / 2 },
    top: { x: 0, y: TABLE.H + 0.2, z: -1.0, yaw: 0.12 },
    centerCrouch: { x: 0, y: TABLE.H + 0.035, z: 0.1, yaw: 0.1 },
  };
  const SLOT_COUNT = 4;
  const CAMERA_MODE_KEY = 'devil.camera';

  const elCam = document.getElementById('scene3d');
  if (!elCam) return;

  try {

  /* ---------------------------------------------------------------------- */
  /*  1. 共用小工具                                                          */
  /* ---------------------------------------------------------------------- */

  const nowMs = () => performance.now();
  const now = () => nowMs() / 1000;
  const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const rand = (a, b) => a + Math.random() * (b - a);
  const lerp = (a, b, t) => a + (b - a) * t;
  /** 角度補間：走最短的那一邊（避免角色轉圈） */
  function dampAngle(current, target, k) {
    let delta = (target - current) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return current + delta * k;
  }

  /** 補間：回傳一個被 tween 管理的 action（tick 時自動更新） */
  const tweens = [];

  function tween(duration, onUpdate, onDone, easeFn = ease) {
    const t0 = now();
    const item = {
      t: 0,
      duration: Math.max(0.001, duration),
      onUpdate,
      onDone,
      easeFn,
      update() {
        this.t = Math.min(1, (now() - t0) / this.duration);
        this.onUpdate(this.easeFn(this.t), this.t);
        if (this.t >= 1) {
          if (this.onDone) this.onDone();
          return false;
        }
        return true;
      },
    };
    tweens.push(item);
    return item;
  }

  /* ---------------------------------------------------------------------- */
  /*  2. renderer / scene / camera                                          */
  /* ---------------------------------------------------------------------- */

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[3D] WebGL 不可用，退回 2D 介面：', err);
    elCam.classList.add('is-failed');
    document.documentElement.classList.add('no-3d');
    return;
  }

  const DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  renderer.setPixelRatio(DPR);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.classList.add('scene3d__canvas');
  elCam.insertBefore(renderer.domElement, elCam.firstChild);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05030a, 0.075);

  /* 相機：預設「俯瞰整張桌子」的上帝視角；玩家可以切回貼近的玩家視角 */
  const CAM_MODES = {
    // 上帝視角：高、斜、但看得到四個座位與桌子中央
    top: { pos: [0, 8.4, 6.6], look: [0, 0.0, -0.35], fov: 46 },
    // 玩家視角：稍微低一點，貼著自己的肩膀看過去
    player: { pos: [0, 3.35, 6.1], look: [0, 0.75, -1.15], fov: 46 },
  };
  let cameraMode = 'top';
  try {
    const saved = window.localStorage && window.localStorage.getItem(CAMERA_MODE_KEY);
    if (saved && CAM_MODES[saved]) cameraMode = saved;
  } catch (err) {
    /* 無痕模式之類的：用預設就好 */
  }

  const CAM = {
    base: new THREE.Vector3(...CAM_MODES[cameraMode].pos),
    look: new THREE.Vector3(...CAM_MODES[cameraMode].look),
    shake: { amp: 0, decay: 0 },
    shakeOffset: new THREE.Vector3(),
    parallax: new THREE.Vector2(),
  };
  const camera = new THREE.PerspectiveCamera(CAM_MODES[cameraMode].fov, 1, 0.1, 60);

  /* ---------------------------------------------------------------------- */
  /*  3. 貼圖（全部用 canvas 現畫，不載入外部檔案）                          */
  /* ---------------------------------------------------------------------- */

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /** 木紋：深棕色 + 隨機纖維 + 接縫 */
  function woodTexture() {
    const c = makeCanvas(512, 512);
    const g = c.getContext('2d');
    g.fillStyle = '#3a2216';
    g.fillRect(0, 0, 512, 512);

    for (let i = 0; i < 220; i++) {
      const y = Math.random() * 512;
      const h = 1 + Math.random() * 3;
      const shade = Math.random() < 0.5 ? 255 : 0;
      g.fillStyle = `rgba(${shade === 255 ? '120,70,40' : '20,10,6'},${0.04 + Math.random() * 0.09})`;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) {
        g.lineTo(x, y + Math.sin((x + i * 13) / 60) * 4 + Math.random() * 2);
      }
      g.lineTo(512, y + h);
      for (let x = 512; x >= 0; x -= 32) {
        g.lineTo(x, y + h + Math.sin((x + i * 13) / 60) * 4);
      }
      g.closePath();
      g.fill();
    }

    // 桌板接縫
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 3;
    for (let i = 1; i < 5; i++) {
      g.beginPath();
      g.moveTo(0, (512 / 5) * i);
      g.lineTo(512, (512 / 5) * i);
      g.stroke();
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 1.3);
    tex.anisotropy = 4;
    return tex;
  }

  /** 圓形柔邊貼圖（給粒子 / 光暈 / 煙霧） */
  function softDotTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
    const c = makeCanvas(128, 128);
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.45, inner.replace(/,1\)$/, ',0.55)'));
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  /** 名字牌 */
  function labelTexture(text, accent) {
    const c = makeCanvas(512, 128);
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 128);
    g.fillStyle = 'rgba(8,3,8,0.72)';
    g.strokeStyle = accent;
    g.lineWidth = 4;
    const r = 26;
    g.beginPath();
    g.moveTo(10 + r, 10);
    g.arcTo(502, 10, 502, 118, r);
    g.arcTo(502, 118, 10, 118, r);
    g.arcTo(10, 118, 10, 10, r);
    g.arcTo(10, 10, 502, 10, r);
    g.closePath();
    g.fill();
    g.stroke();
    g.font = 'bold 54px "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = accent;
    g.shadowBlur = 18;
    g.fillStyle = '#fff3f6';
    g.fillText(text, 256, 66, 460);
    return new THREE.CanvasTexture(c);
  }

  const texWood = woodTexture();
  const texBlood = softDotTexture('rgba(220,20,40,1)', 'rgba(90,0,10,0)');
  const texSpark = softDotTexture('rgba(255,220,150,1)', 'rgba(255,120,0,0)');
  const texGlow = softDotTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');

  /* ---------------------------------------------------------------------- */
  /*  4. 燈光（黑暗、壓抑）                                                  */
  /* ---------------------------------------------------------------------- */

  scene.add(new THREE.HemisphereLight(0x2a1440, 0x0a0408, 0.55));

  /** 兩盞聚光燈：一盞從惡魔那頭上頭打下、一盞從玩家這頭打下 */
  const spotlightDemon = new THREE.SpotLight(0xff2d55, 42, 16, 0.62, 0.55, 1.4);
  spotlightDemon.position.set(-0.6, 6.2, -2.4);
  spotlightDemon.target.position.set(0, 0, -0.6);
  spotlightDemon.castShadow = true;
  spotlightDemon.shadow.mapSize.set(1024, 1024);
  spotlightDemon.shadow.bias = -0.0008;
  scene.add(spotlightDemon, spotlightDemon.target);

  const spotlightPlayer = new THREE.SpotLight(0xffb38a, 26, 16, 0.7, 0.6, 1.5);
  spotlightPlayer.position.set(0.8, 5.4, 3.2);
  spotlightPlayer.target.position.set(0, 0, 0.5);
  spotlightPlayer.castShadow = true;
  spotlightPlayer.shadow.mapSize.set(1024, 1024);
  spotlightPlayer.shadow.bias = -0.0008;
  scene.add(spotlightPlayer, spotlightPlayer.target);

  /* ---------------------------------------------------------------------- */
  /*  5. 桌子                                                               */
  /* ---------------------------------------------------------------------- */

  const tableGroup = new THREE.Group();
  scene.add(tableGroup);

  const tableMat = new THREE.MeshStandardMaterial({
    map: texWood,
    color: 0x5a3720,
    roughness: 0.72,
    metalness: 0.06,
  });
  const tableTop = new THREE.Mesh(new THREE.BoxGeometry(TABLE.W, TABLE.H, TABLE.D), tableMat);
  tableTop.position.y = -TABLE.H / 2;
  tableTop.receiveShadow = true;
  tableTop.castShadow = true;
  tableGroup.add(tableTop);

  // 桌邊的木框
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x2b170d, roughness: 0.6, metalness: 0.15 });
  const rimThick = 0.16;
  const rimH = 0.12;
  for (const [w, d, x, z] of [
    [TABLE.W + rimThick, rimThick, 0, TABLE.D / 2],
    [TABLE.W + rimThick, rimThick, 0, -TABLE.D / 2],
    [rimThick, TABLE.D, TABLE.W / 2, 0],
    [rimThick, TABLE.D, -TABLE.W / 2, 0],
  ]) {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(w, rimH, d), rimMat);
    rim.position.set(x, -rimH / 2 + 0.01, z);
    rim.castShadow = true;
    rim.receiveShadow = true;
    tableGroup.add(rim);
  }

  // 桌腳（細長、往下消失在黑暗裡）
  const legGeo = new THREE.CylinderGeometry(0.09, 0.055, 2.6, 10);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, rimMat);
      leg.position.set(sx * (TABLE.W / 2 - 0.55), -1.4, sz * (TABLE.D / 2 - 0.45));
      leg.castShadow = true;
      tableGroup.add(leg);
    }
  }

  // 桌下地面（把桌子「放」在有地面的空間裡，影子才有地方落）
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x0a0609, roughness: 0.95, metalness: 0.02 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.75;
  floor.receiveShadow = true;
  scene.add(floor);

  // 桌面中央的紅圈（輪盤氛圍）
  const feltRing = new THREE.Mesh(
    new THREE.RingGeometry(1.02, 1.12, 96),
    new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.34, side: THREE.DoubleSide }),
  );
  feltRing.rotation.x = -Math.PI / 2;
  feltRing.position.y = 0.004;
  scene.add(feltRing);

  // 中央的血漬（永遠烙在桌上）
  const stain = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 64),
    new THREE.MeshBasicMaterial({ map: texBlood, transparent: true, opacity: 0.24, depthWrite: false }),
  );
  stain.rotation.x = -Math.PI / 2;
  stain.position.y = 0.006;
  scene.add(stain);

  /* ---------------------------------------------------------------------- */
  /*  6. 角色                                                               */
  /* ---------------------------------------------------------------------- */

  /* --- 6-1 玩家：膠囊體（位置由 setSeats() 依人數決定） --- */
  const playerRig = new THREE.Group();
  playerRig.name = 'seat-you';
  {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf2e6ea, roughness: 0.48, metalness: 0.12 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.82, 12, 24), bodyMat);
    body.position.y = 0.72;
    body.castShadow = true;
    playerRig.add(body);

    // 頭部（決定鏡頭方向的那一端）
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.23, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0x2b1f26, roughness: 0.4, metalness: 0.3 }),
    );
    head.position.y = 1.42;
    head.castShadow = true;
    playerRig.add(head);

    // 肩線（讓膠囊體看起來有「面向」）
    const shoulder = new THREE.Mesh(
      new THREE.BoxGeometry(0.52, 0.1, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x8a1730, roughness: 0.5, metalness: 0.2 }),
    );
    shoulder.position.set(0, 1.12, 0.16);
    playerRig.add(shoulder);

    // 腳下的光環
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.42, 48),
      new THREE.MeshBasicMaterial({ color: 0x2de2ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.02;
    playerRig.add(ring);
    playerRig.userData.ring = ring;

    // 名牌（永遠面向鏡頭）
    const plate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: labelTexture('你', '#2de2ff'), transparent: true, depthWrite: false }),
    );
    plate.scale.set(1.5, 0.375, 1);
    plate.position.set(0, PLATE_Y.you - 0.72, 0);
    playerRig.add(plate);
    playerRig.userData.plate = plate;
    playerRig.userData.plateText = '你';
  }
  {
    const p0 = seatPoint(0);
    playerRig.position.set(p0.x, 0, p0.z);
  }
  scene.add(playerRig);

  /* --- 6-2 惡魔：面向鏡頭的立繪平面（站在你的右手邊那一格附近，讓 Top 座位還給玩家） --- */
  const demonRig = new THREE.Group();
  demonRig.name = 'seat-demon';
  scene.add(demonRig);

  /** 惡魔站的位置：固定在你右手邊、桌子側邊往外一點 */
  const DEMON_HOME = { x: SEAT_RX - 0.1, z: 0.9 };
  demonRig.position.set(DEMON_HOME.x, 0, DEMON_HOME.z);

  const demonPlaneGeo = new THREE.PlaneGeometry(1.62, 1.62);
  const demonMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98, toneMapped: false });
  const demonPlane = new THREE.Mesh(demonPlaneGeo, demonMat);
  demonPlane.position.y = 1.42;
  demonPlane.userData.isDemon = true;
  demonRig.add(demonPlane);

  // 背光光暈（用大張柔光貼圖做 sprite，永遠面向鏡頭）
  const aura = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texGlow,
      color: 0xff2d55,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  aura.scale.set(3.4, 3.4, 1);
  aura.position.set(0, 1.5, -0.25);
  demonRig.add(aura);

  // 名牌：DeepSeek 娘
  const namePlate = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 0.375),
    new THREE.MeshBasicMaterial({ map: labelTexture('DeepSeek 娘', '#ff2d55'), transparent: true, depthWrite: false }),
  );
  namePlate.position.set(0, 2.42, 0.02);
  namePlate.userData.isDemon = true;
  demonRig.add(namePlate);

  // 立繪的血色疊層（被打中時閃紅）
  const demonHurt = new THREE.Mesh(
    demonPlaneGeo,
    new THREE.MeshBasicMaterial({ color: 0xff0018, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
  );
  demonHurt.position.copy(demonPlane.position);
  demonHurt.position.z += 0.01;
  demonHurt.userData.isDemon = true;
  demonRig.add(demonHurt);

  /** 載入立繪（路徑來自 config.DIALOGUE.PORTRAIT 的候選清單） */
  const demonArt = { loaded: false, texture: null, url: '' };
  const loader = new THREE.TextureLoader();

  function loadDemonArt(urls) {
    const list = (urls || []).filter(Boolean);
    if (!list.length) return;
    if (demonArt.url === list[0] && demonArt.loaded) return;

    let index = 0;
    const tryNext = () => {
      if (index >= list.length) {
        console.warn('[3D] 找不到 DeepSeek 娘立繪，使用霓虹替代品。');
        demonArt.loaded = false;
        demonPlane.material.color.set(0x221019);
        return;
      }
      const url = list[index++];
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
          demonArt.texture = tex;
          demonArt.url = url;
          demonArt.loaded = true;

          // 依圖片比例調整平面大小（維持 1.7 的高度）
          const img = tex.image;
          const ratio = img && img.width && img.height ? img.width / img.height : 1;
          const h = 1.72;
          const w = h * ratio;
          demonPlane.geometry.dispose();
          demonPlane.geometry = new THREE.PlaneGeometry(w, h);
          demonHurt.geometry.dispose();
          demonHurt.geometry = new THREE.PlaneGeometry(w, h);

          demonMat.map = tex;
          demonMat.color.set(0xffffff);
          demonMat.needsUpdate = true;
          document.documentElement.classList.add('has-demon-art');
        },
        undefined,
        () => tryNext(),
      );
    };
    tryNext();
  }

  /** 其他座位（多人模式的玩家）：位置由 setSeats() 依人數平均分配 */
  const otherSeats = []; // THREE.Group
  const OTHER_MAX = 3;
  const otherGeo = new THREE.CapsuleGeometry(0.22, 0.6, 8, 16);
  for (let i = 0; i < OTHER_MAX; i++) {
    const g = new THREE.Group();
    g.name = `seat-other-${i}`;
    const body = new THREE.Mesh(otherGeo, new THREE.MeshStandardMaterial({ color: 0x9d8b96, roughness: 0.55, metalness: 0.12 }));
    body.position.y = 0.62;
    body.castShadow = true;
    g.add(body);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.32, 40),
      new THREE.MeshBasicMaterial({ color: 0xff2d55, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.02;
    g.add(ring);
    // 名字牌（每個座位一張，setSeats() 會換文字）
    const plate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: null, transparent: true, opacity: 0, depthWrite: false }),
    );
    plate.scale.set(1.35, 0.34, 1);
    plate.position.set(0, PLATE_Y.other - 0.58, 0);
    g.add(plate);

    g.visible = false;
    g.userData = { index: i, plate, plateText: '', x: 0, z: 0, yaw: 0, tx: 0, tz: 0, tyaw: 0 };
    scene.add(g);
    otherSeats.push(g);
  }

  /* ---------------------------------------------------------------------- */
  /*  7. 道具凹槽（玩家 / 惡魔 兩側）                                        */
  /* ---------------------------------------------------------------------- */

  const slotGroups = { you: [], demon: [] };
  const slotIcons = { you: [], demon: [] };

  function iconTexture(icon) {
    const c = makeCanvas(128, 128);
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    g.font = '72px "Segoe UI Emoji", "Apple Color Emoji", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(icon || '❓', 64, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function buildSlots(side) {
    const isYou = side === 'you';
    // 「你」那一排在你面前的桌邊，「惡魔」那一排在桌子另一側的桌邊
    const z = isYou ? TABLE.D / 2 - 0.52 : -(TABLE.D / 2 - 0.52);
    const spread = 1.15;
    const start = -((SLOT_COUNT - 1) * spread) / 2;

    const cavityMat = new THREE.MeshStandardMaterial({ color: 0x120a08, roughness: 0.95, metalness: 0.05 });
    const edgeMat = new THREE.LineBasicMaterial({
      color: isYou ? 0x2de2ff : 0xff2d55,
      transparent: true,
      opacity: 0.6,
    });

    for (let i = 0; i < SLOT_COUNT; i++) {
      const g = new THREE.Group();
      g.position.set(start + i * spread, 0, z);
      // 玩家那排轉 180°，讓凹槽的「開口」面向自己
      g.rotation.y = isYou ? Math.PI : 0;

      // 凹槽：深色方塊（比桌面低一點點，做出「洞」的感覺）
      const cavity = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.05, 0.44), cavityMat);
      cavity.position.y = 0.006;
      cavity.receiveShadow = true;
      g.add(cavity);

      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.09, 0.5), cavityMat);
      frame.position.y = 0.024;
      g.add(frame);

      // 線框
      const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.72, 0.07, 0.5));
      const line = new THREE.LineSegments(edges, edgeMat);
      line.position.y = 0.05;
      g.add(line);

      // 內側的斜切面（讓凹槽有感）
      const lip = new THREE.Mesh(
        new THREE.BoxGeometry(0.74, 0.02, 0.52),
        new THREE.MeshStandardMaterial({
          color: isYou ? 0x0d3a4a : 0x4a0d1c,
          emissive: isYou ? 0x2de2ff : 0xff2d55,
          emissiveIntensity: 0.25,
          roughness: 0.6,
        }),
      );
      lip.position.y = 0.055;
      g.add(lip);

      // 道具圖示（sprite，永遠面向鏡頭）
      const icon = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: null, transparent: true, opacity: 0, depthWrite: false }),
      );
      icon.scale.set(0.42, 0.42, 1);
      icon.position.set(0, 0.3, 0);
      g.add(icon);
      slotIcons[side].push(icon);

      scene.add(g);
      slotGroups[side].push(g);
    }
  }

  buildSlots('you');
  buildSlots('demon');

  let itemCatalog = {};

  /** 凹槽裡放道具（items = [{id, icon, available}]） */
  const itemIcons = {}; // emoji → THREE.Texture（同一種道具只畫一次 canvas）
  function iconFor(item) {
    const emoji = (item && (item.icon || item.emoji)) || '❔';
    if (!itemIcons[emoji]) itemIcons[emoji] = iconTexture(emoji);
    return itemIcons[emoji];
  }

  function setSlots(side, items) {
    const list = (Array.isArray(items) ? items : []).slice(0, SLOT_COUNT);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const icon = slotIcons[side][i];
      const item = list[i];
      if (!item) {
        icon.material.map = null;
        icon.material.opacity = 0;
        icon.userData.itemId = null;
        icon.material.needsUpdate = true;
        continue;
      }
      const emoji = (item.icon || item.emoji || itemCatalog[item.id] || '❔') + '';
      if (icon.userData.itemId !== item.id + emoji) {
        icon.userData.itemId = item.id + emoji;
        icon.material.map = iconFor(item);
        icon.material.needsUpdate = true;
      }
      icon.material.opacity = item.available === false ? 0.32 : 0.95;
      if (icon.material.color) icon.material.color.set(item.available === false ? 0x6b5b62 : 0xffffff);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  8. 散彈槍（全部由 BoxGeometry / CylinderGeometry 拼出來）              */
  /* ---------------------------------------------------------------------- */

  const gun = new THREE.Group();
  gun.name = 'gun';
  gun.userData.isGun = true;
  gun.position.set(GUN_POSES.center.x, GUN_POSES.center.y, GUN_POSES.center.z);
  gun.rotation.y = GUN_POSES.center.yaw;
  gun.rotation.x = GUN_POSES.centerCrouch.y - GUN_POSES.center.y > 0 ? 0 : 0.06; // 槍口微微朝前
  scene.add(gun);

  const MAT = {
    steel: new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: 0.32, metalness: 0.92 }),
    steelDark: new THREE.MeshStandardMaterial({ color: 0x15181e, roughness: 0.45, metalness: 0.8 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6b3d22, roughness: 0.62, metalness: 0.08 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.28, metalness: 1 }),
    live: new THREE.MeshStandardMaterial({ color: 0xd4111f, emissive: 0x8a0008, emissiveIntensity: 0.7, roughness: 0.4 }),
    blank: new THREE.MeshStandardMaterial({ color: 0x7d7f88, emissive: 0x1a2a33, emissiveIntensity: 0.4, roughness: 0.5 }),
  };

  function box(w, h, d, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  // 槍管（雙管）
  const barrelGroup = new THREE.Group();
  for (const dx of [-0.052, 0.052]) {
    const b = box(0.088, 0.088, 0.98, MAT.steel, dx, 0.05, -0.42);
    barrelGroup.add(b);
  }
  gun.add(barrelGroup);

  // 槍管下的護木
  gun.add(box(0.2, 0.07, 0.3, MAT.wood, 0, 0.005, -0.15));
  // 機匣
  gun.add(box(0.22, 0.15, 0.42, MAT.steelDark, 0, 0.0, 0.16));
  // 上方的擊錘塊
  gun.add(box(0.14, 0.06, 0.14, MAT.steel, 0, 0.1, 0.1));
  // 扳機護圈
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.012, 8, 20, Math.PI), MAT.steel);
  guard.rotation.set(Math.PI / 2, 0, 0);
  guard.position.set(0, -0.075, 0.16);
  gun.add(guard);
  // 扳機
  gun.add(box(0.02, 0.07, 0.02, MAT.steelDark, 0, -0.06, 0.16));

  // 握把（往後下方傾斜）
  const grip = box(0.12, 0.3, 0.15, MAT.wood, 0, -0.18, 0.36);
  grip.rotation.x = -0.38;
  gun.add(grip);

  // 槍托
  const stock = box(0.14, 0.13, 0.52, MAT.wood, 0, -0.12, 0.66);
  stock.rotation.x = -0.12;
  gun.add(stock);
  gun.add(box(0.15, 0.16, 0.06, MAT.steelDark, 0, -0.17, 0.92));

  // 槍口（火焰的錨點）
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.userData.isMuzzle = true;
  muzzle.position.set(0, 0.05, -0.94);
  gun.add(muzzle);

  // 槍管側面的紅色指示燈（讓它在黑暗裡看得見）
  const gunLed = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xff2d55 }),
  );
  gunLed.position.set(0, 0.115, 0.12);
  gun.add(gunLed);

  /** 槍下的紅色光暈：放到桌面高度、水平鋪開，看起來像槍在桌面上發光 */
  const gunHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(1.6, 0.8),
    new THREE.MeshBasicMaterial({
      map: texGlow,
      color: 0xff2d55,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  gunHalo.rotation.x = -Math.PI / 2;
  scene.add(gunHalo);

  /* ---------------------------------------------------------------------- */
  /*  9. 槍口火焰 / 子彈曳光 / 血濺 / 彈殼                                   */
  /* ---------------------------------------------------------------------- */

  // 槍口火焰：PointLight + 兩張 aditive 貼圖（十字 + 柔光）
  const muzzleLight = new THREE.PointLight(0xffb35c, 0, 9, 1.6);
  muzzleLight.name = 'muzzleLight';
  muzzleLight.userData.isMuzzleLight = true;
  muzzleLight.position.set(0, 0.05, -1.1);
  gun.add(muzzleLight);

  const flash = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texSpark,
      color: 0xffd9a0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  flash.scale.set(0.9, 0.9, 1);
  flash.position.set(0, 0.05, -1.02);
  gun.add(flash);

  const flashCore = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texGlow,
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  flashCore.scale.set(0.35, 0.35, 1);
  flashCore.position.set(0, 0.05, -1.0);
  gun.add(flashCore);

  /** 曳光彈：一條細長的光，從槍口往目標飛 */
  const tracers = [];
  function tracer(fromPos, toPos, color = 0xffd27a, life = 0.12) {
    const start = fromPos.clone();
    const end = toPos.clone();
    const geo = new THREE.BufferGeometry().setFromPoints([start, end]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(geo, mat);
    scene.add(line);
    tracers.push({ line, t: 0, life });
  }

  /** 血濺粒子（用 Points） */
  const particles = [];
  function bloodBurst(position, count = 44, color = 0xd4111f) {
    const positions = new Float32Array(count * 3);
    const velocities = [];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = position.x;
      positions[i * 3 + 1] = position.y;
      positions[i * 3 + 2] = position.z;
      velocities.push(
        new THREE.Vector3(rand(-1.6, 1.6), rand(0.6, 3.1), rand(-1.6, 1.6)),
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      map: texBlood,
      color,
      size: 0.13,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    scene.add(points);
    particles.push({ points, velocities, t: 0, life: 1.05 });
  }

  /** 火花（空包彈 / 金屬撞擊） */
  function sparkBurst(position, count = 16) {
    bloodBurst(position, count, 0xffc46b);
  }

  /** 空包彈的彈殼：小小的黃銅圓柱往下掉再消失 */
  const shells = [];
  function ejectShell() {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.1, 10), MAT.brass);
    const p = new THREE.Vector3(0, 0, 0.1);
    gun.localToWorld(p);
    mesh.position.copy(p);
    mesh.rotation.set(rand(-0.4, 0.4), rand(0, 6.28), rand(-0.4, 0.4));
    mesh.castShadow = true;
    scene.add(mesh);
    shells.push({
      mesh,
      vel: new THREE.Vector3(rand(0.6, 1.4), rand(1.4, 2.2), rand(0.2, 0.9)),
      spin: new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)),
      t: 0,
      life: 1.6,
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  10. 相機震動                                                          */
  /* ---------------------------------------------------------------------- */

  function cameraShake(amp = 0.16, duration = 0.42) {
    CAM.shake.amp = Math.max(CAM.shake.amp, amp);
    CAM.shake.decay = Math.max(CAM.shake.decay, duration);
  }

  /* ---------------------------------------------------------------------- */
  /*  11. 對外 API                                                          */
  /* ---------------------------------------------------------------------- */

  /** 讓槍滑到某一側（you / demon / left / right / top / center）並稍微旋轉 */
  let gunPose = 'center';
  let gunPoseBusy = false;

  function moveGunTo(target) {
    const key = gunPoseFor(target);
    gunPose = key;
    const pose = GUN_POSES[key] || GUN_POSES.center;
    const from = {
      x: gun.position.x,
      y: gun.position.y,
      z: gun.position.z,
      yaw: gun.rotation.y,
    };
    gunPoseBusy = true;
    return new Promise((resolve) => {
      tween(
        0.62,
        (e) => {
          gun.position.x = lerp(from.x, pose.x, e);
          gun.position.y = lerp(from.y, pose.y, e) + Math.sin(e * Math.PI) * 0.16;
          gun.position.z = lerp(from.z, pose.z, e);
          gun.rotation.y = lerp(from.yaw, pose.yaw, e) + Math.sin(e * Math.PI) * 0.35;
        },
        () => {
          gunPoseBusy = false;
          resolve();
        },
      );
    });
  }

  let flashTween = null;
  /** 槍口火焰：PointLight 閃爍 + 兩張光斑（用 tween 驅動，不用巢狀 rAF） */
  function muzzleFlash(duration = 0.16, power = 1) {
    tween(
      duration,
      (e, raw) => {
        // 兩段式閃爍：先爆亮、再快速衰減、中間隨機跳一下
        const flicker = Math.random() < 0.25 ? 0.45 : 1;
        const env = Math.pow(1 - raw, 2.2) * flicker;
        muzzleLight.intensity = 26 * power * env;
        flash.material.opacity = Math.min(1, env * 1.4);
        flashCore.material.opacity = Math.min(1, env * 1.8);
        flash.material.rotation = Math.random() * Math.PI;
        flash.scale.setScalar(0.75 + Math.random() * 0.45 + env * 0.5);
      },
      () => {
        muzzleLight.intensity = 0;
        flash.material.opacity = 0;
        flashCore.material.opacity = 0;
      },
      (x) => x, // 線性時間（閃爍不要被 ease 平滑掉）
    );
    flashTween = true;
    void flashTween;
  }

  /** 開槍：火焰 + 震動 + 後座 + 曳光 + 粒子 */
  function fire({ live = true, target = null } = {}) {
    muzzleFlash(live ? 0.2 : 0.12, live ? 1.15 : 0.7);
    cameraShake(live ? 0.3 : 0.12, live ? 0.46 : 0.24);

    // 曳光：從槍口往目標（世界座標）
    const fromWorld = new THREE.Vector3();
    muzzle.getWorldPosition(fromWorld);
    let toWorld;
    if (target) {
      toWorld = new THREE.Vector3(target.x, target.y, target.z);
    } else {
      // 沒有指定目標：往「槍口正前方」飛出去（槍的 -Z 軸）
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(gun.getWorldQuaternion(new THREE.Quaternion()));
      toWorld = fromWorld.clone().add(dir.multiplyScalar(6));
    }
    toWorld.x += rand(-0.08, 0.08);
    toWorld.y += rand(-0.08, 0.08);
    tracer(fromWorld, toWorld, live ? 0xffd27a : 0x9fb4c8, live ? 0.14 : 0.09);

    if (live) {
      // 命中點的血
      bloodBurst(toWorld.clone().add(new THREE.Vector3(0, 0, 0.05)), 56);
      sparkBurst(fromWorld, 14);
    } else {
      sparkBurst(fromWorld, 10);
    }

    // 後座
    const baseZ = gun.position.z;
    const baseRotX = gun.rotation.x;
    tween(0.22, (e) => {
      gun.position.z = baseZ + Math.sin(e * Math.PI) * 0.2;
      gun.rotation.x = baseRotX + Math.sin(e * Math.PI) * 0.22;
    });
  }

  /** 惡魔被打中：立繪閃紅 + 左右劇烈抖動（呼吸動畫暫時停用，避免 transform 打架） */
  function hitDemon() {
    demonPlane.userData.hurt = 1;
    tween(
      0.7,
      (e) => {
        demonHurt.material.opacity = (1 - e) * 0.75;
        demonPlane.position.x = Math.sin(e * Math.PI * 9) * 0.085 * (1 - e);
      },
      () => {
        demonHurt.material.opacity = 0;
        demonPlane.position.x = 0;
      },
    );
  }

  /** 玩家被打中 */
  function hitPlayer() {
    const p = new THREE.Vector3();
    playerRig.children[0].getWorldPosition(p);
    bloodBurst(p.clone().setY(1.0), 40);
    // 受擊時膠囊體閃紅
    const mat = playerRig.children[0].material;
    tween(0.55, (e) => {
      mat.emissive.setRGB((1 - e) * 0.85, 0, (1 - e) * 0.1);
    });
    cameraShake(0.2, 0.35);
  }

  /** 換彈：槍身抬起 + 左右翻轉 + 黃銅彈殼落桌 */
  function reloadSpin() {
    const baseY = gun.position.y;
    tween(
      0.8,
      (e) => {
        gun.position.y = baseY + Math.sin(e * Math.PI) * 0.24;
        gun.rotation.z = Math.sin(e * Math.PI * 2) * 0.5;
      },
      () => {
        gun.rotation.z = 0;
      },
    );
    ejectShell();
  }

  /** 死亡：立繪沉下去、背光熄滅 */
  function demonDead() {
    tween(0.9, (e) => {
      demonPlane.position.y = 1.42 - e * 0.5;
      namePlate.position.y = 2.42 - e * 0.5;
      aura.material.opacity = 0.5 * (1 - e * 0.8);
      demonPlane.userData.deadTint = e;
    });
  }

  function demonAlive() {
    tween(
      0.6,
      (e) => {
        demonPlane.position.y = lerp(demonPlane.position.y, 1.42, e);
        namePlate.position.y = lerp(namePlate.position.y, 2.42, e);
        aura.material.opacity = lerp(aura.material.opacity, 0.45, e);
        demonPlane.userData.deadTint = lerp(demonPlane.userData.deadTint || 0, 0, e);
      },
    );
  }

  /** 誰在動作：讓對應的角色亮起來 */
  let activeAnchor = null;
  function setActive(anchor) {
    activeAnchor = anchor || null;
  }

  /* ---------------------------------------------------------------------- */
  /*  12. 與遊戲狀態同步（由 client.js 呼叫）                                */
  /* ---------------------------------------------------------------------- */

  const bound = { you: null, demon: null };
  /** 目前桌上有幾個座位（1~4）—— 讓相機 / 桌面比例可以跟著人數調整 */
  let seatCount = 1;

  /** 換名字牌的文字（只有真的變了才重畫 canvas） */
  function setPlateText(sprite, text) {
    if (!sprite) return;
    if (sprite.userData.text === text && sprite.material.map) return;
    sprite.userData.text = text;
    sprite.material.map = labelTexture(text || '—', '#ff8fa3');
    sprite.material.opacity = 1;
    sprite.material.needsUpdate = true;
  }

  /**
   * 座位配置：seat 0 一定是你（畫面最上方的「對面」），其餘順時針排。
   *   list: [{ id, name, dead, active, you? }]
   * 人數改變（加入 / 離開）時位置會重新平均分配，並且用 tween 滑過去。
   */
  function setSeats(list) {
    const seats = Array.isArray(list) ? list.filter(Boolean) : [];
    const count = Math.max(1, Math.min(seats.length, 4));
    const fracs = [];
    for (let i = 0; i < count; i++) fracs.push(i / count);

    seats.slice(0, 4).forEach((info, i) => {
      const point = seatPoint(fracs[i]);
      // 面向桌面中心
      const yaw = Math.atan2(-point.x, -point.z);
      const isYou = Boolean(info.you) || i === 0;

      if (isYou) {
        bound.you = info;
        playerRig.visible = true;
        playerRig.userData.tx = point.x;
        playerRig.userData.tz = point.z;
        playerRig.userData.tyaw = yaw;
        if (playerRig.userData.ring) {
          playerRig.userData.ring.material.color.set(info.dead ? 0x4a3a40 : 0x2de2ff);
        }
        const body = playerRig.children[0];
        if (body && body.material) {
          body.material.color.set(info.dead ? 0x6b5b62 : 0xf2e6ea);
          body.material.opacity = info.dead ? 0.45 : 1;
          body.material.transparent = Boolean(info.dead);
          body.material.needsUpdate = true;
        }
        setPlateText(playerRig.userData.plate, info.name || '你');
        return;
      }

      const g = otherSeats[i - 1];
      if (!g) return;
      g.visible = true;
      g.userData.seatId = info.id;
      g.userData.tx = point.x;
      g.userData.tz = point.z;
      g.userData.tyaw = yaw;
      g.userData.dead = Boolean(info.dead);
      g.userData.active = Boolean(info.active);
      g.userData.name = info.name || '玩家';
      setPlateText(g.userData.plate, g.userData.name);
      const body = g.children[0];
      if (body && body.material) {
        body.material.color.set(info.dead ? 0x5a4b52 : info.active ? 0xffe4ea : 0x9d8b96);
        body.material.transparent = Boolean(info.dead);
        body.material.opacity = info.dead ? 0.35 : 1;
        body.material.needsUpdate = true;
      }
      const ring = g.children[1];
      if (ring && ring.material) ring.material.opacity = info.dead ? 0.1 : 0.35;
    });

    // 多出來的角色收起來
    for (let i = Math.max(0, count - 1); i < otherSeats.length; i++) {
      otherSeats[i].visible = false;
    }
    // 人數變少時「你」仍要歸位
    bound.you = seats[0] || null;
    seatCount = count;
  }
  /** 槍要停在誰那邊（接受任何座位 anchor 名稱） */
  function gunPoseFor(anchor) {
    if (anchor === 'you') return 'you';
    if (anchor === 'demon') return 'demon';
    if (anchor === 'left') return 'left';
    if (anchor === 'right') return 'right';
    if (anchor === 'top' || anchor === 'other') return 'top';
    return 'center';
  }

  function setDemonState(state) {
    // state: { hp, maxHp, dead, name }
    if (!state) return;
    if (state.dead) {
      if (!demonRig.userData.dead) demonDead();
    } else {
      demonAlive();
    }
    demonRig.userData.dead = Boolean(state.dead);
    demonRig.visible = state.visible !== false;
    bound.demon = state;
  }

  function setDemonItems(items) {
    setSlots('demon', items);
  }

  function setPlayerItems(items) {
    setSlots('you', items);
  }

  /** 道具圖鑑：client.js 把 config.ITEMS 的 id → icon 對照表送進來 */
  function setItemCatalog(catalog) {
    if (!catalog || typeof catalog !== 'object') return;
    for (const key of Object.keys(catalog)) {
      itemIcons[catalog[key]] = itemIcons[catalog[key]] || iconTexture(catalog[key]);
    }
    itemCatalog = Object.assign(itemCatalog, catalog);
  }

  function setDemoArt(urls) {
    loadDemonArt(urls);
  }

  /* ---------------------------------------------------------------------- */
  /*  13. 主迴圈                                                            */
  /* ---------------------------------------------------------------------- */

  let width = 0;
  let height = 0;
  const targetCameraPos = new THREE.Vector3().copy(CAM.base);

  /** 依「目前的相機模式 + 螢幕長寬比 + 人數」算出相機該站哪裡 */
  function computeCameraBase() {
    const mode = CAM_MODES[cameraMode] || CAM_MODES.top;
    const aspect = width / height;
    let dist = 1;
    if (aspect < 0.8) dist = 1.5;
    else if (aspect < 1) dist = 1.34;
    else if (aspect < 1.4) dist = 1.16;
    else if (aspect > 2.1) dist = 0.92;
    // 人多時往外拉一點，四張臉才不會擠在一起
    dist *= 1 + (seatCount - 1) * 0.045;
    CAM.base.set(mode.pos[0], mode.pos[1] * dist, mode.pos[2] * dist);
    CAM.look.set(mode.look[0], mode.look[1], mode.look[2]);
    camera.fov = mode.fov + (aspect < 1 ? 6 : 0);
  }

  function resize() {
    const rect = elCam.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    computeCameraBase();
    camera.updateProjectionMatrix();
  }
  /** 切換視角：'top' 俯瞰整張桌子 / 'player' 貼近玩家肩膀 */
  function setCameraMode(mode) {
    if (!CAM_MODES[mode]) return cameraMode;
    cameraMode = mode;
    try {
      window.localStorage.setItem(CAMERA_MODE_KEY, mode);
    } catch (err) {
      /* 無痕模式忽略 */
    }
    computeCameraBase();
    camera.updateProjectionMatrix();
    return cameraMode;
  }

  function getCameraMode() {
    return cameraMode;
  }

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) {
    new ResizeObserver(() => resize()).observe(elCam);
  }
  resize();

  /* 滑鼠視差（很輕微，讓場景有呼吸感；俯瞰模式不做，避免整張桌子晃） */
  window.addEventListener('pointermove', (e) => {
    CAM.parallax.x = (e.clientX / window.innerWidth - 0.5) * 2;
    CAM.parallax.y = (e.clientY / window.innerHeight - 0.5) * 2;
  });

  let visible = true;
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
  });

  let last = now();
  let lastNowMs = nowMs();
  let lastDt = 0;
  let frames = 0;
  const tmpVec = new THREE.Vector3();

  function frame() {
    requestAnimationFrame(frame);
    const t = now();
    const nowMsHere = nowMs();
    let dt = t - last;
    last = t;
    lastDt = nowMsHere - lastNowMs;
    lastNowMs = nowMsHere;
    frames += 1;
    if (dt > 0.1) dt = 0.1; // 切回分頁時不要一次跳太大
    if (!visible) return;

    /* --- 補間 --- */
    for (let i = tweens.length - 1; i >= 0; i--) {
      if (!tweens[i].update()) tweens.splice(i, 1);
    }

    /* --- 槍：沒在動作時，微微浮動 --- */
    if (!gunPoseBusy) {
      gun.position.y = damp(gun.position.y, (GUN_POSES[gunPose] || GUN_POSES.center).y + Math.sin(t * 1.4) * 0.012, 8, dt);
    }

    /* --- 角色呼吸 / 惡魔立繪微動 --- */
    const breathe = 1 + Math.sin(t * 1.6) * 0.012;
    playerRig.children[0].scale.set(1, breathe, 1);
    playerRig.userData.ring.material.opacity = activeAnchor === 'you' ? 0.55 + Math.sin(t * 6) * 0.25 : 0.28;

    // 惡魔：面向鏡頭（billboard）+ 極輕微的呼吸位移
    const dead = demonRig.userData.dead;
    const dScale = dead ? 0.97 : 1 + Math.sin(t * 1.3) * 0.008;
    demonPlane.scale.setScalar(dScale);
    demonHurt.scale.setScalar(dScale);
    aura.scale.setScalar(3.4 * (1 + Math.sin(t * 2.1) * 0.04) * (dead ? 0.6 : 1));
    aura.material.opacity = dead ? 0.12 : 0.42 + Math.sin(t * 2.1) * 0.12;
    // 死亡的程度（0 = 活著、1 = 死透）→ 立繪去飽和、變暗
    const tint = demonPlane.userData.deadTint || 0;
    demonPlane.material.color.setRGB(lerp(0.55, 1, 1 - tint), lerp(0.14, 1, 1 - tint), lerp(0.2, 1, 1 - tint));
    if (activeAnchor === 'demon' && !dead) {
      aura.material.color.setHex(0xff2d55);
      spotlightDemon.intensity = 42 + Math.sin(t * 4) * 8;
    } else {
      spotlightDemon.intensity = damp(spotlightDemon.intensity, dead ? 14 : 34, 4, dt);
    }

    // 惡魔立繪永遠面向鏡頭（讓它看起來是「一張面向你」的畫）
    demonPlane.lookAt(camera.position);
    demonHurt.lookAt(camera.position);
    namePlate.lookAt(camera.position);
    namePlate.position.y = PLATE_Y.demon;

    /* --- 座位：人數變動時平滑滑到新位置 --- */
    const lerpRate = 1 - Math.exp(-4.5 * dt);
    // 你：固定在 frac 0（畫面最下方，背對鏡頭）
    if (playerRig.visible) {
      const u = playerRig.userData;
      u.x = lerp(u.x === undefined ? u.tx : u.x, u.tx, lerpRate);
      u.z = lerp(u.z === undefined ? u.tz : u.z, u.tz, lerpRate);
      playerRig.position.set(u.x, 0, u.z);
      playerRig.rotation.y = dampAngle(playerRig.rotation.y, u.tyaw, lerpRate);
      if (u.plate) u.plate.lookAt(camera.position);
    }
    for (const g of otherSeats) {
      if (!g.visible) continue;
      const u = g.userData;
      u.x = lerp(u.x === undefined ? u.tx : u.x, u.tx, lerpRate);
      u.z = lerp(u.z === undefined ? u.tz : u.z, u.tz, lerpRate);
      g.position.set(u.x, 0, u.z);
      g.rotation.y = dampAngle(g.rotation.y, u.tyaw, lerpRate);
      if (u.plate) {
        u.plate.lookAt(camera.position);
        // 輪到這個人時，名字牌發亮
        u.plate.material.opacity = u.dead ? 0.35 : u.active ? 0.95 + Math.sin(t * 5) * 0.05 : 0.62;
      }
    }

    /* --- 霓虹環轉動 --- */
    feltRing.rotation.z = t * 0.12;
    stain.material.opacity = 0.18 + Math.sin(t * 0.9) * 0.05;

    /* --- 曳光 --- */
    for (let i = tracers.length - 1; i >= 0; i--) {
      const tr = tracers[i];
      tr.t += dt;
      const k = Math.min(1, tr.t / tr.life);
      tr.line.material.opacity = 1 - k;
      if (k >= 1) {
        scene.remove(tr.line);
        tr.line.geometry.dispose();
        tr.line.material.dispose();
        tracers.splice(i, 1);
      }
    }

    /* --- 粒子 --- */
    for (let i = particles.length - 1; i >= 0; i--) {
      const ps = particles[i];
      ps.t += dt;
      const pos = ps.points.geometry.attributes.position;
      for (let p = 0; p < ps.velocities.length; p++) {
        const v = ps.velocities[p];
        v.y -= 6.5 * dt; // 重力
        pos.array[p * 3] += v.x * dt;
        pos.array[p * 3 + 1] += v.y * dt;
        pos.array[p * 3 + 2] += v.z * dt;
        if (pos.array[p * 3 + 1] < 0.02) {
          pos.array[p * 3 + 1] = 0.02;
          v.set(0, 0, 0);
        }
      }
      pos.needsUpdate = true;
      ps.points.material.opacity = Math.max(0, 1 - ps.t / ps.life);
      if (ps.t >= ps.life) {
        scene.remove(ps.points);
        ps.points.geometry.dispose();
        ps.points.material.dispose();
        particles.splice(i, 1);
      }
    }

    /* --- 彈殼 --- */
    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i];
      s.t += dt;
      s.vel.y -= 9.8 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      if (s.mesh.position.y <= 0.03) {
        s.mesh.position.y = 0.03;
        s.vel.set(s.vel.x * 0.55, Math.abs(s.vel.y) * 0.32, s.vel.z * 0.55);
        s.spin.multiplyScalar(0.5);
      }
      if (s.t >= s.life) {
        scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        shells.splice(i, 1);
      }
    }

    /* --- 相機 --- */
    const sh = CAM.shake;
    if (sh.amp > 0.0005) {
      const k = sh.amp;
      CAM.shakeOffset.set(rand(-k, k), rand(-k, k), rand(-k, k) * 0.6);
      sh.amp *= Math.pow(0.0022, dt);
      if (sh.amp < 0.0005) sh.amp = 0;
    } else {
      CAM.shakeOffset.multiplyScalar(0.8);
    }

    targetCameraPos.copy(CAM.base);
    const par = cameraMode === 'top' ? 0.35 : 1; // 俯瞰視角只留一點點視差
    targetCameraPos.x += CAM.parallax.x * 0.22 * par + CAM.shakeOffset.x;
    targetCameraPos.y += -CAM.parallax.y * 0.12 * par + CAM.shakeOffset.y;
    targetCameraPos.z += CAM.shakeOffset.z;

    camera.position.lerp(targetCameraPos, 1 - Math.exp(-6 * dt));
    camera.lookAt(CAM.look);
    camera.rotation.z += CAM.shakeOffset.x * 0.12;

    /* --- 槍與槍下的光暈 --- */
    scene.updateMatrixWorld();
    gun.getWorldPosition(gunHalo.position);
    gunHalo.position.y = TABLE.H + 0.004;
    gunHalo.material.opacity = 0.1 + Math.sin(t * 2.2) * 0.04;

    renderer.render(scene, camera);
  }

  gunHalo.position.set(GUN_POSES.center.x, TABLE.H + 0.004, GUN_POSES.center.z);

  resize();
  frame();

  /* 立繪預設路徑（client.js 拿到 config 後會再呼叫 setDemoArt 覆寫） */
  loadDemonArt(['/assets/deepseek_girl.jpg', '/deepseek_girl.png', '/assets/deepseek_girl.png']);

  /* ---------------------------------------------------------------------- */
  /*  14. 點擊（raycast）：在 3D 場景裡直接點惡魔 / 槍                        */
  /* ---------------------------------------------------------------------- */

  /** picker 是一個透明的 2D 圖層（在 canvas 之上、UI 之下），只在遊戲畫面時接收點擊 */
  const picker = document.getElementById('scenePick');
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pickTargets = [demonPlane, demonHurt, namePlate];
  const listeners = { demonClick: [], gunClick: [] };

  function on(kind, fn) {
    if (listeners[kind]) listeners[kind].push(fn);
  }

  function pickAt(clientX, clientY) {
    if (!picker) return null;
    const rect = picker.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(pickTargets, false);
    if (hits.length) return 'demon';
    const gunHits = raycaster.intersectObject(gun, true);
    if (gunHits.length) return 'gun';
    return null;
  }

  if (picker) {
    let pointer = { x: 0, y: 0 };

    picker.addEventListener('pointermove', (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      const hit = pickAt(e.clientX, e.clientY);
      picker.dataset.hover = hit || '';
    });

    picker.addEventListener('pointerdown', (e) => {
      pointer = { x: e.clientX, y: e.clientY };
    });

    picker.addEventListener('pointerup', (e) => {
      // 拖曳不算點擊
      if (Math.abs(e.clientX - pointer.x) > 6 || Math.abs(e.clientY - pointer.y) > 6) return;
      const hit = pickAt(e.clientX, e.clientY);
      if (!hit) return;
      for (const fn of listeners[hit + 'Click'] || []) fn(e);
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  15. 暴露給 client.js                                                  */
  /* ---------------------------------------------------------------------- */

  window.Scene3D = {
    ready: true,
    THREE,
    scene,
    camera,
    renderer,
    /* --- 動作 --- */
    moveGunTo,
    fire,
    muzzleFlash,
    cameraShake,
    hitDemon,
    hitPlayer,
    reloadSpin,
    /* --- 狀態同步 --- */
    setActive,
    setSeats,
    setDemonState,
    setDemonItems,
    setPlayerItems,
    setItemCatalog,
    setDemoArt,
    /* --- 相機 --- */
    setCameraMode,
    getCameraMode,
    /* --- 互動 --- */
    on,
    /* --- 座標查詢（client.js 用來擺 2D 浮動文字 / 粒子落點） --- */
    demonWorld: () => {
      const v = new THREE.Vector3();
      demonPlane.getWorldPosition(v);
      return v;
    },
    gunMuzzleWorld: () => {
      const v = new THREE.Vector3();
      muzzle.getWorldPosition(v);
      return v;
    },
    playerWorld: () => {
      const v = new THREE.Vector3();
      playerRig.children[0].getWorldPosition(v);
      v.y = 1.05;
      return v;
    },
    /** 把世界座標投影成螢幕座標（扣血數字 / 血濺粒子的落點） */
    project(point) {
      tmpVec.copy(point).project(camera);
      return {
        x: ((tmpVec.x + 1) / 2) * window.innerWidth,
        y: ((1 - tmpVec.y) / 2) * window.innerHeight,
        visible: tmpVec.z < 1,
      };
    },
  };

  document.documentElement.classList.add('has-3d');
  console.log('[3D] 桌面場景就緒');

  // 除錯 / 測試用的唯讀快照（不可列舉、不可覆寫，避免被當成公開 API 誤用）
  Object.defineProperty(window.Scene3D, 'debug', {
    value: () => ({
      docHidden: document.hidden,
      pose: gunPose,
      busy: gunPoseBusy,
      z: gun.position.z,
      n: tweens.length,
      t0: tweens[0] ? tweens[0].t : null,
      dur: tweens[0] ? tweens[0].duration : null,
      lastDt,
      frames,
    }),
    enumerable: false,
  });

  // 任何一步建場景時炸掉（不是只有 WebGL 失敗）也要退回 2D，不要讓整頁白屏
  } catch (err) {
    console.warn('[3D] 初始化失敗，退回 2D 介面：', err);
    document.documentElement.classList.add('no-3d');
    if (elCam) elCam.classList.add('is-failed');
  }
})();
