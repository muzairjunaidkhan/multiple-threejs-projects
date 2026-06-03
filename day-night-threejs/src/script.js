import * as THREE from 'three';
import gsap from 'gsap';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* =========================================================
   CANVAS & SCENE
   ========================================================= */
const canvas = document.querySelector('.webgl');
const scene = new THREE.Scene();

/* =========================================================
   LOADING MANAGER  –  REAL asset-based loading screen
   A THREE.LoadingManager tracks every loader you register.
   onProgress fires per asset; onLoad fires when ALL finish.
   ========================================================= */
const loadingScreen = document.createElement('div');
loadingScreen.classList.add('loading-screen');
loadingScreen.innerHTML = `
  <div class="ls-inner">
    <div class="ls-bar-wrap"><div class="ls-bar" id="ls-bar"></div></div>
    <p class="ls-pct" id="ls-pct">0%</p>
  </div>`;
document.body.appendChild(loadingScreen);

// Inject minimal loading-screen CSS (keeps everything in one JS file)
const lsStyle = document.createElement('style');
lsStyle.textContent = `
  .loading-screen {
    position: fixed; inset: 0; z-index: 9999;
    background: #000814;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Georgia', serif; color: #e0fbfc;
    transition: opacity 1s;
  }
  .ls-inner { text-align: center; }
  .ls-title  { font-size: 2.5rem; letter-spacing: .15em; margin: 0 0 .25rem; }
  .ls-sub    { font-size: 1rem;  opacity: .6; margin: 0 0 2rem; }
  .ls-bar-wrap { width: 260px; height: 4px; background: #1a2a3a; border-radius: 2px; margin: 0 auto 1rem; }
  .ls-bar    { height: 100%; width: 0; background: #ffb703; border-radius: 2px; transition: width .2s; }
  .ls-pct    { margin: 0; font-size: .85rem; opacity: .5; }

`;
document.head.appendChild(lsStyle);


const loadingManager = new THREE.LoadingManager(
  /* onLoad */
  () => {
    gsap.to(loadingScreen, {
      opacity: 0, duration: 1.2, delay: 0.3,
      onComplete: () => loadingScreen.remove()
    });
  },
  /* onProgress */
  (_url, loaded, total) => {
    const pct = Math.round((loaded / total) * 100);
    document.getElementById('ls-bar').style.width = pct + '%';
    document.getElementById('ls-pct').textContent = pct + '%';
  }
);

/* =========================================================
   SIZES  &  RESIZE
   ========================================================= */
const sizes = { width: window.innerWidth, height: window.innerHeight };

window.addEventListener('resize', () => {
  sizes.width = window.innerWidth;
  sizes.height = window.innerHeight;
  camera.aspect = sizes.width / sizes.height;
  camera.updateProjectionMatrix();
  renderer.setSize(sizes.width, sizes.height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

/* =========================================================
   CAMERA
   ========================================================= */
const camera = new THREE.PerspectiveCamera(75, sizes.width / sizes.height, 0.1, 1000);
camera.position.set(18, 12, 18);
scene.add(camera);

/* =========================================================
   RENDERER
   ========================================================= */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(sizes.width, sizes.height);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

/* =========================================================
   CONTROLS
   ========================================================= */
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 6
controls.maxDistance = 100

/* =========================================================
   FOG
   ========================================================= */
// scene.fog = new THREE.FogExp2('#000814', 0.015);


/* =========================================================
   TEXTURES  –  registered with loadingManager so the real
   loading bar actually tracks them
   ========================================================= */
const textureLoader = new THREE.TextureLoader(loadingManager);

// Simple procedural textures baked into data-URLs so the
// project works without any texture files on disk, yet the
// LoadingManager still counts them as real async loads.
function makeDataURL(r, g, b) {
  const c = document.createElement('canvas');
  c.width = c.height = 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, 2, 2);
  return c.toDataURL();
}

const groundTex = textureLoader.load(makeDataURL(27, 67, 50)); // dark green
const wallTex = textureLoader.load(makeDataURL(173, 181, 189)); // grey
const roofTex = textureLoader.load(makeDataURL(127, 85, 57)); // brown
const trunkTex = textureLoader.load(makeDataURL(92, 61, 46)); // bark
const leafTex = textureLoader.load(makeDataURL(45, 106, 79)); // leaf

/* =========================================================
   GROUND
   ========================================================= */
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(100, 100),
  new THREE.MeshStandardMaterial({ map: groundTex, color: '#1b4332' })
);
ground.rotation.x = -Math.PI * 0.5;
ground.receiveShadow = true;
scene.add(ground);

// HOUSE
const house = new THREE.Group();
scene.add(house);

// --- Walls ---
const walls = new THREE.Mesh(
  new THREE.BoxGeometry(4, 3, 4),
  new THREE.MeshStandardMaterial({ map: wallTex, color: '#adb5bd' })
);
walls.position.y = 1.5;
walls.castShadow = true;
walls.receiveShadow = true;
house.add(walls);

// --- Roof ---
const roof = new THREE.Mesh(
  new THREE.ConeGeometry(3.5, 2, 4),
  new THREE.MeshStandardMaterial({ map: roofTex, color: '#7f5539' })
);
roof.position.y = 3 + 1;        // top of wall (3) + half cone (1)
roof.rotation.y = Math.PI * 0.25;
roof.castShadow = true;
house.add(roof);

// --- Door  (visible rectangle on the FRONT face, z = +2) ---
const door = new THREE.Mesh(
  new THREE.PlaneGeometry(0.8, 1.4),
  new THREE.MeshStandardMaterial({ color: '#5c3d2e', side: THREE.DoubleSide })
);
door.position.set(0, 0.7, 2.01); // just in front of the wall face
house.add(door);

// --- Window left ---
const winL = new THREE.Mesh(
  new THREE.PlaneGeometry(0.6, 0.6),
  new THREE.MeshStandardMaterial({ color: '#90e0ef', transparent: true, opacity: 0.6 })
);
winL.position.set(-1.1, 1.6, 2.01);
house.add(winL);

// --- Window right ---
const winR = winL.clone();
winR.position.set(1.1, 1.6, 2.01);
house.add(winR);

// --- Door Light ---
const doorLight = new THREE.PointLight('#ffb703', 8, 15);
doorLight.position.set(0, 2.2, 2.5);  // outside the front wall
doorLight.castShadow = true;
house.add(doorLight);


//    TREES
function createTree(x, z) {
  const group = new THREE.Group();

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.25, 2),
    new THREE.MeshStandardMaterial({ map: trunkTex, color: '#5c3d2e' })
  );
  trunk.position.y = 1;          // bottom at y=0
  trunk.castShadow = true;
  group.add(trunk);

  const leaves = new THREE.Mesh(
    new THREE.ConeGeometry(1, 3, 8),
    new THREE.MeshStandardMaterial({ map: leafTex, color: '#2d6a4f' })
  );
  leaves.position.y = 2 + 1.5;  // on top of trunk
  leaves.castShadow = true;
  group.add(leaves);

  group.position.set(x, 0, z);
  scene.add(group);
}

// Keep a clear radius of 5 units around the house (which is at 0,0)
let treesPlaced = 0;
while (treesPlaced < 30) {
  const x = (Math.random() - 0.5) * 60;
  const z = (Math.random() - 0.5) * 60;
  const dist = Math.sqrt(x * x + z * z);
  if (dist > 5) {                // exclusion zone
    createTree(x, z);
    treesPlaced++;
  }
}


// SUN & MOON
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(2, 32, 32),
  new THREE.MeshBasicMaterial({ color: '#ffb703' })
);
scene.add(sun);

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(1.3, 32, 32),
  new THREE.MeshBasicMaterial({ color: '#e0fbfc' })
);
scene.add(moon);


// LIGHTS
const sunLight = new THREE.DirectionalLight('#ffffff', 3);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = 100;
sunLight.shadow.camera.left = sunLight.shadow.camera.bottom = -30;
sunLight.shadow.camera.right = sunLight.shadow.camera.top = 30;
scene.add(sunLight);
scene.add(sunLight.target);   // target stays at origin

const ambientLight = new THREE.AmbientLight('#ffffff', 0.3);
scene.add(ambientLight);

// Soft blue moonlight
const moonLight = new THREE.DirectionalLight('#a8dadc', 0);
moonLight.castShadow = false;
scene.add(moonLight);


/* =========================================================
   STARS  (particles)
   ========================================================= */
const starsGeo = new THREE.BufferGeometry();
const starsCount = 4000;
const starsPos = new Float32Array(starsCount * 3);
for (let i = 0; i < starsCount * 3; i++) starsPos[i] = (Math.random() - 0.5) * 300;
starsGeo.setAttribute('position', new THREE.BufferAttribute(starsPos, 3));

const starsMat = new THREE.PointsMaterial({
  color: '#ffffff', size: 0.15, sizeAttenuation: false,
  transparent: true, opacity: 0
});
const stars = new THREE.Points(starsGeo, starsMat);
scene.add(stars);


// FIREFLIES
const FIREFLY_COUNT = 250;

const ffPositions = new Float32Array(FIREFLY_COUNT * 3);
const ffBasePos = new Float32Array(FIREFLY_COUNT * 3); // home positions
const ffPhase = new Float32Array(FIREFLY_COUNT);     // individual phase
const ffSpeed = new Float32Array(FIREFLY_COUNT);     // individual speed
const ffAmplitude = new Float32Array(FIREFLY_COUNT);     // individual amp

for (let i = 0; i < FIREFLY_COUNT; i++) {
  const x = (Math.random() - 0.5) * 22;
  const y = 0.3 + Math.random() * 4;           // close to ground to treetop
  const z = (Math.random() - 0.5) * 22;

  ffBasePos[i * 3 + 0] = ffPositions[i * 3 + 0] = x;
  ffBasePos[i * 3 + 1] = ffPositions[i * 3 + 1] = y;
  ffBasePos[i * 3 + 2] = ffPositions[i * 3 + 2] = z;

  ffPhase[i] = Math.random() * Math.PI * 2; // random start phase
  ffSpeed[i] = 0.4 + Math.random() * 1.2;  // 0.4 – 1.6 Hz
  ffAmplitude[i] = 0.05 + Math.random() * 0.25; // 0.05 – 0.3 units
}

const ffGeo = new THREE.BufferGeometry();
ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPositions, 3));

const ffMat = new THREE.PointsMaterial({
  color: '#ffd60a', size: 0.18,
  transparent: true, opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false
});
const fireflies = new THREE.Points(ffGeo, ffMat);
scene.add(fireflies);

// Per-firefly opacity driven by a separate attribute for punchy blink
// (PointsMaterial doesn't support per-vertex alpha natively without a
//  custom shader, so we cheat: we fade the whole material but pair it
//  with size variation to give the illusion of individual blinking)
const ffSizes = new Float32Array(FIREFLY_COUNT);
for (let i = 0; i < FIREFLY_COUNT; i++) ffSizes[i] = 0.18;
ffGeo.setAttribute('size', new THREE.BufferAttribute(ffSizes, 1));

/* =========================================================
   CLOCK & ANIMATION LOOP
   ========================================================= */
const clock = new THREE.Clock();
let angle = 0;
const ORBIT_RADIUS = 30;

const tick = () => {
  const elapsed = clock.getElapsedTime();

  /* ---- Day / Night cycle ---- */
  angle += 0.002;

  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  sun.position.set(cosA * ORBIT_RADIUS, sinA * ORBIT_RADIUS, -10);
  moon.position.set(-cosA * ORBIT_RADIUS, -sinA * ORBIT_RADIUS, -10);

  // Sun directional light tracks sun
  sunLight.position.copy(sun.position);
  sunLight.target.position.set(0, 0, 0);
  sunLight.target.updateMatrixWorld();

  // Moon light tracks moon
  moonLight.position.copy(moon.position);

  const isDay = sun.position.y > 0;
  const sunFrac = Math.max(0, sun.position.y / ORBIT_RADIUS);  // 0-1
  const moonFrac = Math.max(0, -sun.position.y / ORBIT_RADIUS); // 0-1

  // Sun light  (bright during day, dims as sun sets)
  sunLight.intensity = sunFrac * 4;
  // Ambient light varies smoothly
  ambientLight.intensity = 0.08 + sunFrac * 0.55;
  // Moon light grows at night
  moonLight.intensity = moonFrac * 0.8;

  // Sky colour: interpolate from midnight blue → dawn orange → sky blue
  if (isDay) {
    const dawn = sunFrac < 0.15;
    renderer.setClearColor(dawn ? '#f4a261' : '#87ceeb');
    starsMat.opacity = Math.max(0, 1 - sunFrac * 6);
    ffMat.opacity = Math.max(0, 0.9 - sunFrac * 5);
  } else {
    renderer.setClearColor('#03071e');
    starsMat.opacity = Math.min(1, moonFrac * 4);
    ffMat.opacity = Math.min(0.9, moonFrac * 3);
  }

  /* ---- Fireflies: independent organic drift ---- */
  const ffPos = fireflies.geometry.attributes.position.array;
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    const t = elapsed * ffSpeed[i] + ffPhase[i];
    const amp = ffAmplitude[i];

    // Each firefly drifts in a small Lissajous-ish figure around its base
    ffPos[i * 3 + 0] = ffBasePos[i * 3 + 0] + Math.sin(t * 1.3) * amp;
    ffPos[i * 3 + 1] = ffBasePos[i * 3 + 1] + Math.sin(t) * amp * 0.6;
    ffPos[i * 3 + 2] = ffBasePos[i * 3 + 2] + Math.cos(t * 0.9) * amp;
  }
  fireflies.geometry.attributes.position.needsUpdate = true;

  /* ---- Stars slow rotation ---- */
  stars.rotation.y = elapsed * 0.02;

  /* ---- House gentle float ---- */
  house.position.y = Math.sin(elapsed * 0.6) * 0.04;

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
};

tick();