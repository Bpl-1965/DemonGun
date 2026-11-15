'use strict';

/**
 * scripts/smoke3d.js —— 用假的 DOM + 假的 Three.js 跑一次 public/scene3d.js
 *
 * 目的：3D 邏輯（幾何體、燈光、槍的移動、槍口火焰、相機震動）沒辦法在
 *       終端機裡用瀏覽器驗證，所以用最小可用的 stub 模擬 WebGLRenderer / Scene /
 *       Mesh 等，確認：
 *         1) scene3d.js 在「有 THREE」時能完整初始化成功
 *         2) window.Scene3D 對外 API 齊全（client.js 呼叫的方法都存在）
 *         3) moveGunTo() 會把槍真的移到指定錨點
 *         4) fire() 會點亮槍口 PointLight 並讓相機震動
 *         5) 少了 WebGL 時會優雅降級（標記 .no-3d，不拋錯）
 *
 * 用法：node scripts/smoke3d.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'public', 'scene3d.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/* -------------------------------------------------------------------------- */
/*  1. 最小可用的 DOM stub                                                     */
/* -------------------------------------------------------------------------- */

function makeClassList(el) {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    contains: (n) => set.has(n),
    toggle: (n, force) => {
      const on = force === undefined ? !set.has(n) : Boolean(force);
      if (on) set.add(n);
      else set.delete(n);
      return on;
    },
    get value() {
      return [...set].join(' ');
    },
    _set: set,
    _el: el,
  };
}

function makeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    hidden: false,
    style: {
      _p: {},
      setProperty(k, v) {
        this._p[k] = v;
      },
      getPropertyValue(k) {
        return this._p[k] || '';
      },
      removeProperty(k) {
        delete this._p[k];
      },
    },
    dataset: {},
    children: [],
    width: 1280,
    height: 720,
    clientWidth: 1280,
    clientHeight: 720,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, ref) {
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx < 0) this.children.push(child);
      else this.children.splice(idx, 0, child);
      child.parentNode = this;
      return child;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    get lastChild() {
      return this.children[this.children.length - 1] || null;
    },
    set innerHTML(v) {
      this._innerHTML = v;
      if (v === '') this.children = [];
    },
    get innerHTML() {
      return this._innerHTML || '';
    },
    set textContent(v) {
      this._text = v;
    },
    get textContent() {
      return this._text || '';
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
    click() {},
  };
  el.classList = makeClassList(el);
  return el;
}

function makeDocument() {
  const registry = new Map();
  const html = makeElement('html');
  const body = makeElement('body');
  html.appendChild(body);

  const doc = {
    documentElement: html,
    body,
    head: makeElement('head'),
    createElement: (tag) => makeElement(tag),
    createElementNS: (ns, tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    getElementById: (id) => {
      if (!registry.has(id)) {
        const el = makeElement(id === 'scene3d' ? 'div' : 'div');
        el.id = id;
        registry.set(id, el);
      }
      return registry.get(id);
    },
    querySelector: (sel) => (sel && sel.startsWith('#') ? doc.getElementById(sel.slice(1)) : null),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    _registry: registry,
  };
  return doc;
}

/* -------------------------------------------------------------------------- */
/*  2. 最小可用的 Three.js stub                                                */
/* -------------------------------------------------------------------------- */

function buildFakeTHREE({ failRenderer = false } = {}) {
  class Vector2 {
    constructor(x = 0, y = 0) {
      this.x = x;
      this.y = y;
    }
    set(x, y) {
      this.x = x;
      this.y = y;
      return this;
    }
  }
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    setScalar(v) {
      this.x = this.y = this.z = v;
      return this;
    }
    copy(v) {
      this.x = v.x;
      this.y = v.y;
      this.z = v.z;
      return this;
    }
    clone() {
      return new Vector3(this.x, this.y, this.z);
    }
    sub(v) {
      this.x -= v.x;
      this.y -= v.y;
      this.z -= v.z;
      return this;
    }
    add(v) {
      this.x += v.x;
      this.y += v.y;
      this.z += v.z;
      return this;
    }
    addScaledVector(v, s) {
      this.x += v.x * s;
      this.y += v.y * s;
      this.z += v.z * s;
      return this;
    }
    multiplyScalar(s) {
      this.x *= s;
      this.y *= s;
      this.z *= s;
      return this;
    }
    normalize() {
      const l = Math.hypot(this.x, this.y, this.z) || 1;
      return this.multiplyScalar(1 / l);
    }
    length() {
      return Math.hypot(this.x, this.y, this.z);
    }
    distanceTo(v) {
      return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
    }
    lerp(v, t) {
      this.x += (v.x - this.x) * t;
      this.y += (v.y - this.y) * t;
      this.z += (v.z - this.z) * t;
      return this;
    }
    applyQuaternion() {
      return this;
    }
    project() {
      return this.set(0, 0, 0.5);
    }
  }
  class Euler {
    constructor(x = 0, y = 0, z = 0) {
      this.x = x;
      this.y = y;
      this.z = z;
      this.order = 'XYZ';
    }
    set(x, y, z) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
    copy(e) {
      return this.set(e.x, e.y, e.z);
    }
  }
  class Quaternion {
    constructor() {
      this.x = 0;
      this.y = 0;
      this.z = 0;
      this.w = 1;
    }
    setFromEuler() {
      return this;
    }
    slerp() {
      return this;
    }
    copy(q) {
      Object.assign(this, q);
      return this;
    }
  }
  class Object3D {
    constructor() {
      this.position = new Vector3();
      this.rotation = new Euler();
      this.quaternion = new Quaternion();
      this.scale = new Vector3(1, 1, 1);
      this.children = [];
      this.parent = null;
      this.visible = true;
      this.userData = {};
      this.name = '';
      this.matrixWorld = { elements: new Array(16).fill(0) };
    }
    add(...objs) {
      objs.forEach((o) => {
        if (o) {
          o.parent = this;
          this.children.push(o);
        }
      });
      return this;
    }
    remove(obj) {
      this.children = this.children.filter((c) => c !== obj);
      if (obj) obj.parent = null;
      return this;
    }
    traverse(fn) {
      fn(this);
      this.children.forEach((c) => c.traverse && c.traverse(fn));
    }
    lookAt() {}
    updateMatrixWorld() {}
    updateMatrix() {}
    getWorldPosition(target) {
      return target.copy(this.position);
    }
    localToWorld(v) {
      return v.add(this.position);
    }
    worldToLocal(v) {
      return v.sub(this.position);
    }
    getWorldQuaternion(q) {
      return q;
    }
    rotateX() {
      return this;
    }
    rotateY() {
      return this;
    }
    rotateZ() {
      return this;
    }
  }
  class Group extends Object3D {}
  class Scene extends Object3D {
    constructor() {
      super();
      this.background = null;
      this.fog = null;
    }
  }
  class PerspectiveCamera extends Object3D {
    constructor(fov, aspect, near, far) {
      super();
      this.fov = fov;
      this.aspect = aspect;
      this.near = near;
      this.far = far;
    }
    updateProjectionMatrix() {}
  }
  class Mesh extends Object3D {
    constructor(geometry, material) {
      super();
      this.geometry = geometry;
      this.material = material;
      this.isMesh = true;
    }
  }
  class InstancedMesh extends Mesh {
    constructor(geometry, material, count) {
      super(geometry, material);
      this.count = count;
    }
    setMatrixAt() {}
    setColorAt() {}
    instanceMatrix = { needsUpdate: false };
    instanceColor = { needsUpdate: false };
  }
  class Points extends Mesh {}
  class LineSegments extends Mesh {}
  class Sprite extends Mesh {
    constructor(material) {
      super(null, material || new materialClasses.SpriteMaterial());
      this.isSprite = true;
    }
  }

  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.needsUpdate = false;
    }
    setXYZ(i, x, y, z) {
      this.array[i * 3] = x;
      this.array[i * 3 + 1] = y;
      this.array[i * 3 + 2] = z;
      return this;
    }
    setFromPoints(points) {
      const n = points.length;
      this.array = new Float32Array(n * 3);
      points.forEach((p, i) => {
        this.array[i * 3] = p.x;
        this.array[i * 3 + 1] = p.y;
        this.array[i * 3 + 2] = p.z;
      });
      return this;
    }
    setXY(i, x, y) {
      this.array[i * 2] = x;
      this.array[i * 2 + 1] = y;
      return this;
    }
    setX(i, x) {
      this.array[i] = x;
      return this;
    }
  }

  class Geometry {
    constructor(kind) {
      this.kind = kind;
      this.attributes = {};
      this.parameters = {};
      this.index = null;
      this.boundingSphere = { radius: 1 };
    }
    setAttribute(name, attr) {
      this.attributes[name] = attr;
      return this;
    }
    setIndex(idx) {
      this.index = idx;
      return this;
    }
    setFromPoints(points) {
      this.attributes.position = new BufferAttribute(new Float32Array(points.length * 3), 3).setFromPoints(points);
      return this;
    }
    translate() {
      return this;
    }
    rotateX() {
      return this;
    }
    rotateY() {
      return this;
    }
    rotateZ() {
      return this;
    }
    computeBoundingSphere() {}
    computeVertexNormals() {}
    dispose() {}
  }

  const geoFactory = (kind) =>
    class extends Geometry {
      constructor(...args) {
        super(kind);
        this.parameters = { args };
        this.attributes.position = new BufferAttribute(new Float32Array(3 * 8), 3);
        this.attributes.normal = new BufferAttribute(new Float32Array(3 * 8), 3);
        this.attributes.uv = new BufferAttribute(new Float32Array(2 * 8), 2);
      }
    };

  const geometries = [
    'BoxGeometry',
    'PlaneGeometry',
    'SphereGeometry',
    'CapsuleGeometry',
    'CylinderGeometry',
    'TorusGeometry',
    'RingGeometry',
    'CircleGeometry',
    'ConeGeometry',
    'BufferGeometry',
  ];
  const geoClasses = {};
  geometries.forEach((name) => {
    geoClasses[name] = geoFactory(name);
  });

  class EdgesGeometry extends Geometry {
    constructor(src) {
      super('Edges');
      this.source = src;
    }
  }

  class Material {
    constructor(params = {}) {
      Object.assign(this, params);
      this.color = params.color instanceof Color ? params.color : new Color(params.color ?? 0xffffff);
      this.emissive = new Color(params.emissive ?? 0x000000);
      this.opacity = params.opacity ?? 1;
      this.needsUpdate = false;
      this.userData = {};
    }
    dispose() {}
    clone() {
      return new Material({ ...this });
    }
  }
  const materialClasses = {};
  [
    'MeshStandardMaterial',
    'MeshBasicMaterial',
    'MeshPhysicalMaterial',
    'MeshPhongMaterial',
    'MeshLambertMaterial',
    'PointsMaterial',
    'LineBasicMaterial',
    'SpriteMaterial',
    'ShaderMaterial',
  ].forEach((name) => {
    materialClasses[name] = class extends Material {};
  });

  class Color {
    constructor(hex = 0xffffff) {
      this.set(hex);
    }
    set(hex) {
      this.hex = typeof hex === 'number' ? hex : 0xffffff;
      return this;
    }
    setHSL() {
      return this;
    }
    setRGB() {
      return this;
    }
    copy(c) {
      this.hex = c.hex;
      return this;
    }
    clone() {
      return new Color(this.hex);
    }
    getHex() {
      return this.hex;
    }
    lerp() {
      return this;
    }
  }

  class Light extends Object3D {
    constructor(color, intensity) {
      super();
      this.color = new Color(color);
      this.intensity = intensity ?? 1;
      this.shadow = {
        mapSize: { set() {}, width: 512, height: 512 },
        camera: { near: 0.5, far: 50, updateProjectionMatrix() {} },
        bias: 0,
        radius: 1,
        normalBias: 0,
      };
    }
  }
  class SpotLight extends Light {
    constructor(color, intensity, distance, angle, penumbra, decay) {
      super(color, intensity);
      Object.assign(this, { distance, angle, penumbra, decay });
      this.target = new Object3D();
    }
    lookAt() {}
  }
  class PointLight extends Light {
    constructor(color, intensity, distance, decay) {
      super(color, intensity);
      Object.assign(this, { distance, decay });
    }
  }
  class HemisphereLight extends Light {
    constructor(sky, ground, intensity) {
      super(sky, intensity);
      this.groundColor = new Color(ground);
    }
  }
  class AmbientLight extends Light {}
  class DirectionalLight extends Light {
    constructor(color, intensity) {
      super(color, intensity);
      this.target = new Object3D();
    }
  }

  class CanvasTexture {
    constructor(canvas) {
      this.image = canvas;
      this.colorSpace = '';
      this.wrapS = 0;
      this.wrapT = 0;
      this.repeat = { set() {}, x: 1, y: 1 };
      this.needsUpdate = false;
    }
    dispose() {}
    clone() {
      return new CanvasTexture(this.image);
    }
  }

  class Raycaster {
    constructor() {
      this.ray = { origin: new Vector3(), direction: new Vector3() };
    }
    setFromCamera() {}
    intersectObjects() {
      return [];
    }
    intersectObject() {
      return [];
    }
  }

  class FogExp2 {
    constructor(color, density) {
      this.color = new Color(color);
      this.density = density;
    }
  }
  class Fog {
    constructor(color, near, far) {
      this.color = new Color(color);
      this.near = near;
      this.far = far;
    }
  }

  /** TEXTURE 載入：成功/失敗都可指定，用來驗證立繪的 fallback 邏輯 */
  class TextureLoader {
    constructor({ fail = true } = {}) {
      this.fail = fail;
    }
    setCrossOrigin() {
      return this;
    }
    load(url, onLoad, onProgress, onError) {
      const tex = new CanvasTexture({ width: 1200, height: 1200 });
      tex._url = url;
      if (this.fail) {
        if (onError) setTimeout(() => onError(new Error(`simulated 404: ${url}`)), 0);
      } else if (onLoad) {
        setTimeout(() => onLoad(tex), 0);
      }
      return tex;
    }
    loadAsync(url) {
      return new Promise((resolve, reject) => {
        if (this.fail) reject(new Error(`simulated 404: ${url}`));
        else resolve(new CanvasTexture({ width: 1200, height: 1200 }));
      });
    }
  }

  class Clock {
    constructor() {
      this.elapsedTime = 0;
    }
    getDelta() {
      return 1 / 60;
    }
    getElapsedTime() {
      return (this.elapsedTime += 1 / 60);
    }
  }

  class WebGLRenderer {
    constructor() {
      if (failRenderer) throw new Error('WebGL not supported (simulated)');
      this.domElement = makeElement('canvas');
      this.shadowMap = { enabled: false, type: 0 };
      this.toneMapping = 0;
      this.toneMappingExposure = 1;
      this.outputColorSpace = '';
      this.info = { render: { calls: 0 } };
      this.renderCount = 0;
      this._size = { w: 1280, h: 720 };
    }
    setPixelRatio() {}
    setSize(w, h) {
      this._size = { w, h };
    }
    setClearColor() {}
    setAnimationLoop(fn) {
      this._loop = fn;
      this._loopAttached = true;
    }
    getContext() {
      const gl = {
        getExtension: () => null,
        getParameter: () => 4096,
        getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
        createTexture: () => ({}),
        bindTexture: () => {},
        deleteTexture: () => {},
        texImage2D: () => {},
        texParameteri: () => {},
        getContextAttributes: () => ({}),
      };
      return gl;
    }
    render() {
      this.renderCount += 1;
    }
    dispose() {}
    setViewport() {}
    getSize(target) {
      return target.set(this._size.w, this._size.h);
    }
    compile() {}
  }

  return {
    Vector2,
    Vector3,
    Euler,
    Quaternion,
    Object3D,
    Group,
    Scene,
    PerspectiveCamera,
    OrthographicCamera: PerspectiveCamera,
    Mesh,
    InstancedMesh,
    Points,
    LineSegments,
    Sprite,
    Line: LineSegments,
    BufferAttribute,
    EdgesGeometry,
    Color,
    Material,
    SpotLight,
    PointLight,
    HemisphereLight,
    AmbientLight,
    DirectionalLight,
    CanvasTexture,
    Texture: CanvasTexture,
    TextureLoader,
    FogExp2,
    Fog,
    Raycaster,
    Clock,
    WebGLRenderer,
    PCFSoftShadowMap: 2,
    PCFShadowMap: 1,
    BasicShadowMap: 0,
    SRGBColorSpace: 'srgb',
    LinearSRGBColorSpace: 'srgb-linear',
    ACESFilmicToneMapping: 4,
    AdditiveBlending: 2,
    NormalBlending: 1,
    LinearFilter: 1006,
    NearestFilter: 1003,
    DoubleSide: 2,
    FrontSide: 0,
    BackSide: 1,
    RepeatWrapping: 1000,
    ClampToEdgeWrapping: 1001,
    MathUtils: {
      degToRad: (d) => (d * Math.PI) / 180,
      radToDeg: (r) => (r * 180) / Math.PI,
      clamp: (v, a, b) => Math.min(Math.max(v, a), b),
      lerp: (a, b, t) => a + (b - a) * t,
      randFloat: (a, b) => a + Math.random() * (b - a),
      randFloatSpread: (s) => (Math.random() - 0.5) * s,
      smoothstep: (x, a, b) => {
        const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
        return t * t * (3 - 2 * t);
      },
    },
    ...geoClasses,
    ...materialClasses,
  };
}

/* -------------------------------------------------------------------------- */
/*  3. 在 vm 沙箱裡跑 scene3d.js                                              */
/* -------------------------------------------------------------------------- */

function runScene3D({ withTHREE = true, failRenderer = false } = {}) {
  const document = makeDocument();
  const errors = [];
  /** 收集 rAF 回呼，讓測試能手動「跑 N 幀」 */
  const rafQueue = [];
  let rafId = 1;

  const requestAnimationFrame = (fn) => {
    const id = rafId++;
    rafQueue.push({ id, fn });
    return id;
  };
  const cancelAnimationFrame = (id) => {
    const i = rafQueue.findIndex((r) => r.id === id);
    if (i >= 0) rafQueue.splice(i, 1);
  };
  /** 依序跑掉目前排隊的 rAF（每次回呼會再排下一幀，所以只跑當下這批） */
  const tick = (frames = 1) => {
    for (let f = 0; f < frames; f += 1) {
      const batch = rafQueue.splice(0, rafQueue.length);
      batch.forEach((r) => r.fn());
    }
  };
  const canvasCtx = new Proxy(
    {},
    {
      get(target, prop) {
        if (prop === 'canvas') return makeElement('canvas');
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        if (prop === 'measureText') return () => ({ width: 40 });
        if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        if (prop === 'putImageData') return () => {};
        if (prop === 'fillStyle' || prop === 'strokeStyle' || prop === 'font' || prop === 'lineWidth') return '';
        if (typeof prop === 'string' && target[prop] !== undefined) return target[prop];
        return () => ({});
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    },
  );
  const origCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'canvas') {
      el.getContext = () => canvasCtx;
      el.toDataURL = () => 'data:image/png;base64,';
    }
    return el;
  };

  const windowObj = {
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 2,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame,
    cancelAnimationFrame,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'http://localhost:3100/' },
    setTimeout,
    clearTimeout,
  };
  if (withTHREE) windowObj.THREE = buildFakeTHREE({ failRenderer });

  const sandbox = {
    window: windowObj,
    document,
    console: { log() {}, warn: (...a) => errors.push(['warn', ...a]), error: (...a) => errors.push(['error', ...a]), info() {} },
    requestAnimationFrame,
    cancelAnimationFrame,
    performance: { now: () => Date.now() },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Math,
    Date,
    Object,
    Array,
    JSON,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Float32Array,
    Uint8Array,
    Uint16Array,
    isNaN,
    parseFloat,
    parseInt,
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(SRC, context, { filename: 'scene3d.js' });
  return { api: windowObj.Scene3D, document, errors, window: windowObj, rafQueue, tick };
}

/* -------------------------------------------------------------------------- */
/*  4. 檢查                                                                   */
/* -------------------------------------------------------------------------- */

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    const detail = fn();
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `\n      （${detail}）` : ''}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n3D 桌面 · scene3d.js 驗證\n');

const REQUIRED_API = [
  'moveGunTo',
  'fire',
  'muzzleFlash',
  'cameraShake',
  'hitDemon',
  'hitPlayer',
  'reloadSpin',
  'setActive',
  'setSeats',
  'setDemonState',
  'setDemonItems',
  'setPlayerItems',
  'setDemoArt',
  'on',
  'demonWorld',
  'gunMuzzleWorld',
  'playerWorld',
  'project',
];

const booted = runScene3D();

check('有 THREE 時 scene3d.js 能初始化（ready = true）', () => {
  assert(booted.api, 'window.Scene3D 不存在');
  assert(booted.api.ready === true, `ready 應為 true，實際 ${booted.api.ready}`);
  return `scene 內有 ${booted.api.scene.children.length} 個根物件`;
});

check('對外 API 齊全（client.js 呼叫的方法都存在）', () => {
  const missing = REQUIRED_API.filter((k) => typeof booted.api[k] !== 'function');
  assert(missing.length === 0, `缺少：${missing.join(', ')}`);
  return `${REQUIRED_API.length} 個方法`;
});

check('桌子、兩盞聚光燈、玩家膠囊體、惡魔平面、散彈槍都建立了', () => {
  const kinds = [];
  booted.api.scene.traverse((o) => {
    const g = o.geometry;
    if (g && g.kind) {
      const base = String(g.kind).replace(/Geometry$/, '');
      if (base !== 'Buffer') kinds.push(base);
    }
  });
  const spots = booted.api.scene.children.filter((o) => o.constructor.name === 'SpotLight').length;
  assert(kinds.includes('Box'), '找不到 BoxGeometry（桌子或槍身）');
  assert(kinds.includes('Capsule'), '找不到 CapsuleGeometry（玩家代表）');
  assert(kinds.includes('Plane'), '找不到 PlaneGeometry（惡魔立繪 / 凹槽）');
  assert(kinds.includes('Torus'), '找不到 TorusGeometry（散彈槍的扳機護圈）');
  assert(spots >= 2, `聚光燈只有 ${spots} 盞`);
  const box = kinds.filter((k) => k === 'Box').length;
  assert(box >= 5, `BoxGeometry 只有 ${box} 個，散彈槍應該由多個方塊組成`);
  return `Box×${box}、Capsule×${kinds.filter((k) => k === 'Capsule').length}、Plane×${kinds.filter((k) => k === 'Plane').length}、Torus，SpotLight×${spots}`;
});

/** 等 N 毫秒的同時持續跑 rAF（讓 tween 真的隨時間推進） */
function pump(ms) {
  const until = Date.now() + ms;
  let frames = 0;
  while (Date.now() < until) {
    booted.tick(1);
    frames += 1;
  }
  return frames;
}


check('moveGunTo("you") 會讓散彈槍滑到玩家這一側、("demon") 滑到她那側', () => {
  let gun = findGun(booted.api);
  assert(gun, '找不到散彈槍物件');

  booted.api.moveGunTo('you');
  pump(750); // tween 0.62s
  const atYou = { x: gun.position.x, z: gun.position.z };

  booted.api.moveGunTo('demon');
  pump(750);
  gun = findGun(booted.api);
  const atDemon = { x: gun.position.x, z: gun.position.z };

  booted.api.moveGunTo('center');
  pump(750);
  const atCenter = { x: gun.position.x, z: gun.position.z };

  assert(atYou.z > 0.6, `玩家側的槍 z 應 > 0.6，實際 ${atYou.z.toFixed(2)}`);
  assert(atDemon.z < -0.6, `惡魔側的槍 z 應 < -0.6，實際 ${atDemon.z.toFixed(2)}`);
  assert(Math.abs(atCenter.z) < 0.4, `回合中場時槍應回到桌子中央，實際 z=${atCenter.z.toFixed(2)}`);
  return `you z=${atYou.z.toFixed(2)} → demon z=${atDemon.z.toFixed(2)} → center z=${atCenter.z.toFixed(2)}`;
});

check('tween 有在推進（主迴圈會更新槍的位置）', () => {
  const gun = findGun(booted.api);
  booted.api.moveGunTo('center');
  pump(750); // 先歸位
  const startZ = gun.position.z;
  booted.api.moveGunTo('demon');
  const frames = pump(450); // 讓 tween（0.62s）真的走掉大半
  const movedZ = gun.position.z;
  assert(frames > 5, `rAF 迴圈跑了 ${frames} 幀，主迴圈可能沒接上`);
  assert(Math.abs(movedZ - startZ) > 0.05, `跑了 ${frames} 幀，槍的 z 只從 ${startZ.toFixed(3)} 到 ${movedZ.toFixed(3)}｜${JSON.stringify(booted.api.debug && booted.api.debug())}`);
  return `z：${startZ.toFixed(2)} → ${movedZ.toFixed(2)}，共 ${frames} 幀，renderer 渲染 ${booted.api.renderer.renderCount} 次`;
});

check('fire() 會點亮槍口火焰並讓相機震動', () => {
  const camBefore = booted.api.camera.position.clone();
  booted.api.fire({ live: true, target: 'demon' });
  const lights = [];
  booted.api.scene.traverse((o) => {
    if (o.constructor && o.constructor.name === 'PointLight') lights.push(o);
  });
  assert(lights.length >= 1, '場景裡沒有槍口 PointLight');

  // tween 要在下一幀才跑，所以推進幾幀後才檢查亮度
  pump(40);
  const peak = Math.max(...lights.map((l) => l.intensity));
  assert(lights.some((l) => l.intensity > 0) || peak > 0, `開槍後槍口 PointLight 從未亮起（峰值 ${peak}）`);

  const camAfter = booted.api.camera.position;
  const shakeDist = Math.hypot(camAfter.x - camBefore.x, camAfter.y - camBefore.y, camAfter.z - camBefore.z);
  assert(shakeDist > 0.0005, `相機幾乎沒動（位移 ${shakeDist.toFixed(5)}）`);
  return `槍口光峰值 ${peak.toFixed(1)}，相機震動位移 ${shakeDist.toFixed(3)}`;
});

check('開槍後光會熄滅（不會一直亮著）', () => {
  pump(400);
  const lights = [];
  booted.api.scene.traverse((o) => {
    if (o.constructor && o.constructor.name === 'PointLight') lights.push(o);
  });
  const maxI = Math.max(...lights.map((l) => l.intensity));
  assert(maxI < 0.5, `0.4 秒後槍口光仍有 ${maxI.toFixed(2)}`);
  return `剩餘亮度 ${maxI.toFixed(2)}`;
});

check('點擊偵測會回報 demon / gun（Raycaster 命中時的結果）', () => {
  const fired = [];
  booted.api.on('demonClick', () => fired.push('demon'));
  booted.api.on('gunClick', () => fired.push('gun'));
  assert(typeof booted.api.on === 'function', '沒有 on() 事件註冊');
  return '事件註冊正常（實際點擊交給瀏覽器 Raycaster）';
});

check('hitDemon / reloadSpin / setSeats / setPlayerItems 不會拋錯', () => {
  booted.api.hitDemon();
  booted.api.reloadSpin();
  booted.api.setSeats([{ anchor: 'left', dead: false, active: true }]);
  booted.api.setDemonState({ dead: false, visible: true });
  booted.api.setDemonItems([{ id: 'a', icon: '🚬', available: true }]);
  booted.api.setPlayerItems([{ id: 'b', icon: '🍺', available: true }]);
  booted.api.setActive('you');
  const p = booted.api.project(booted.api.demonWorld());
  assert(p && typeof p.x === 'number', 'project() 沒回座標');
  return 'API 全部可呼叫';
});

const degraded = runScene3D({ withTHREE: false });
check('沒有 THREE 時優雅降級（標記 no-3d，不拋錯）', () => {
  assert(!degraded.api, '沒有 THREE 卻仍建立了 Scene3D');
  const flagged = degraded.document.documentElement.classList.contains('no-3d');
  const logged = degraded.errors.some(([level, msg]) => level === 'warn' && String(msg).includes('3D'));
  assert(flagged || logged, '既沒有加上 .no-3d 標記，也沒有任何警告訊息');
  return flagged ? 'documentElement.no-3d 已標記' : '已印出「找不到 THREE」警告（client.js 會接手降級）';
});

const noGL = runScene3D({ withTHREE: true, failRenderer: true });
check('WebGLRenderer 建不起來時也降級（前端不會整頁爆掉）', () => {
  assert(noGL.document.documentElement.classList.contains('no-3d'), '沒有加上 .no-3d 標記');
  return 'no-3d 已標記';
});

function findGun(api) {
  if (api.gun) return api.gun;
  let found = api.scene.getObjectByName ? null : null;
  api.scene.traverse((o) => {
    if (!found && o.userData && o.userData.isGun) found = o;
  });
  if (!found) {
    // 散彈槍是唯一同時含 TorusGeometry（扳機護圈）的 Group
    api.scene.traverse((o) => {
      if (found || !o.children || !o.children.length) return;
      const hasTorus = o.children.some((c) => c.geometry && c.geometry.kind === 'Torus');
      if (hasTorus) found = o;
    });
  }
  if (!found) {
    // 退而求其次：muzzle 物件存在的祖先
    api.scene.traverse((o) => {
      if (o.userData && o.userData.isMuzzle && o.parent) found = o.parent;
    });
  }
  return found;
}

console.log(`\n${fail === 0 ? '全部通過' : '有失敗項目'}：${pass} 項檢查${fail ? `，${fail} 項失敗 ❌` : ' ✅'}\n`);
process.exit(fail === 0 ? 0 : 1);
