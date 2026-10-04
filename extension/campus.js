// campus.js — 캠퍼스 배경 장면 컴포넌트(캐릭터 없음).
// sidepanel.js / options.js / confirm.js가 공용으로 불러 쓴다. 외부 의존성 없음, 전부 코드로 그린 원본 SVG.
// innerHTML은 여기 정의된 고정(static) 마크업에만 쓰고, 페이지/서버/AI 데이터는 절대 넣지 않는다.

const STATES = new Set(['idle', 'study', 'walk', 'success']);

// 고정 SVG 캠퍼스 배경 (원본 일러스트).
const SCENE_SVG = `
<svg class="campus-scene__svg" viewBox="0 0 640 240" preserveAspectRatio="xMidYMax slice" role="img" aria-label="광운대학교 캠퍼스 일러스트">
  <defs>
    <linearGradient id="kwSky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fdf6ea"/>
      <stop offset="100%" stop-color="#f3e3df"/>
    </linearGradient>
    <linearGradient id="kwGround" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#a7bd9d"/>
      <stop offset="100%" stop-color="#8aa180"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="640" height="240" fill="url(#kwSky)"/>

  <g class="campus-cloud" opacity="0.9">
    <ellipse cx="90" cy="34" rx="30" ry="12" fill="#ffffff"/>
    <ellipse cx="114" cy="28" rx="20" ry="10" fill="#ffffff"/>
  </g>
  <g class="campus-cloud campus-cloud--b" opacity="0.85">
    <ellipse cx="330" cy="26" rx="26" ry="10" fill="#ffffff"/>
    <ellipse cx="352" cy="22" rx="16" ry="8" fill="#ffffff"/>
  </g>
  <g class="campus-cloud campus-cloud--c" opacity="0.8">
    <ellipse cx="560" cy="40" rx="24" ry="10" fill="#ffffff"/>
  </g>

  <path d="M0,168 Q160,150 320,166 T640,160 L640,240 L0,240 Z" fill="url(#kwGround)"/>
  <path d="M0,168 Q160,150 320,166 T640,160" fill="none" stroke="#728a67" stroke-width="2" opacity="0.5"/>

  <path d="M20,196 C120,210 180,178 320,186 C440,192 520,172 620,182" fill="none" stroke="#f3e3cf" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 12" opacity="0.9"/>

  <!-- 나무 -->
  <g>
    <g transform="translate(40,188)">
      <rect x="-2" y="0" width="4" height="14" fill="#7a5a3a"/>
      <circle cx="0" cy="-10" r="12" fill="#7fa06f"/>
      <circle cx="-7" cy="-4" r="8" fill="#8fb17f"/>
    </g>
    <g transform="translate(205,200)">
      <rect x="-2" y="0" width="4" height="12" fill="#7a5a3a"/>
      <circle cx="0" cy="-9" r="10" fill="#7fa06f"/>
    </g>
    <g transform="translate(455,198)">
      <rect x="-2" y="0" width="4" height="13" fill="#7a5a3a"/>
      <circle cx="0" cy="-9" r="11" fill="#8fb17f"/>
    </g>
    <g transform="translate(600,192)">
      <rect x="-2" y="0" width="4" height="14" fill="#7a5a3a"/>
      <circle cx="0" cy="-10" r="12" fill="#7fa06f"/>
      <circle cx="7" cy="-5" r="7" fill="#8fb17f"/>
    </g>
  </g>

  <!-- 광운스퀘어 -->
  <g transform="translate(70,0)">
    <rect x="-38" y="128" width="76" height="52" rx="3" fill="#f6ead6" stroke="#7a1f2e" stroke-width="2"/>
    <rect x="-38" y="118" width="76" height="12" fill="#7a1f2e"/>
    <rect x="-28" y="138" width="14" height="16" fill="#93a98a" opacity="0.8"/>
    <rect x="-7" y="138" width="14" height="16" fill="#93a98a" opacity="0.8"/>
    <rect x="14" y="138" width="14" height="16" fill="#93a98a" opacity="0.8"/>
    <rect x="-28" y="160" width="14" height="16" fill="#93a98a" opacity="0.6"/>
    <rect x="-7" y="160" width="14" height="16" fill="#93a98a" opacity="0.6"/>
    <rect x="14" y="160" width="14" height="16" fill="#93a98a" opacity="0.6"/>
  </g>

  <!-- 비마관 (중앙, 시계탑) -->
  <g transform="translate(320,0)">
    <rect x="-52" y="112" width="104" height="68" fill="#faf0de" stroke="#7a1f2e" stroke-width="2"/>
    <polygon points="-58,112 0,86 58,112" fill="#7a1f2e"/>
    <rect x="-9" y="76" width="18" height="16" fill="#7a1f2e"/>
    <circle cx="0" cy="70" r="9" fill="#faf3e6" stroke="#7a1f2e" stroke-width="2"/>
    <line x1="0" y1="70" x2="0" y2="65" stroke="#7a1f2e" stroke-width="1.5"/>
    <line x1="0" y1="70" x2="4" y2="70" stroke="#7a1f2e" stroke-width="1.5"/>
    <rect x="-38" y="128" width="16" height="20" fill="#93a98a" opacity="0.8"/>
    <rect x="-9" y="128" width="18" height="24" fill="#7a1f2e" opacity="0.85"/>
    <rect x="22" y="128" width="16" height="20" fill="#93a98a" opacity="0.8"/>
    <rect x="-38" y="154" width="16" height="18" fill="#93a98a" opacity="0.6"/>
    <rect x="22" y="154" width="16" height="18" fill="#93a98a" opacity="0.6"/>
  </g>

  <!-- 도서관 -->
  <g transform="translate(560,0)">
    <rect x="-46" y="130" width="92" height="50" fill="#f6ead6" stroke="#7a1f2e" stroke-width="2"/>
    <polygon points="-52,130 0,108 52,130" fill="#93a98a"/>
    <rect x="-36" y="140" width="6" height="30" fill="#efe0c4"/>
    <rect x="-22" y="140" width="6" height="30" fill="#efe0c4"/>
    <rect x="-8" y="140" width="6" height="30" fill="#efe0c4"/>
    <rect x="6" y="140" width="6" height="30" fill="#efe0c4"/>
    <rect x="20" y="140" width="6" height="30" fill="#efe0c4"/>
    <rect x="-10" y="150" width="20" height="4" fill="#7a1f2e" opacity="0.7"/>
  </g>
</svg>`;

/**
 * 캠퍼스 장면을 container에 그리고 제어 핸들을 돌려준다.
 * @param {HTMLElement} container
 * @param {{state?:'idle'|'study'|'walk'|'success', motion?:boolean, compact?:boolean,
 *          badge?:boolean, onToggleMotion?:(on:boolean)=>void}} opts
 */
export function mountCampusScene(container, opts = {}) {
  let state = opts.state ?? 'idle';
  let motion = opts.motion !== false;
  let paused = false;
  let successTimer = null;
  const reduceMotionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  const root = document.createElement('div');
  root.className = 'campus-scene' + (opts.compact ? ' campus-scene--compact' : '');
  root.innerHTML = SCENE_SVG; // 고정 마크업만 포함(외부/AI 데이터 없음)

  if (opts.badge !== false) {
    const badge = document.createElement('span');
    badge.className = 'campus-badge';
    badge.textContent = '비공식 · 개인용';
    root.appendChild(badge);
  }

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'campus-toggle';
  const setToggleLabel = () => {
    toggleBtn.textContent = paused || !motion ? '▶ 움직임' : '⏸ 멈춤';
    toggleBtn.setAttribute('aria-pressed', String(paused || !motion));
  };
  toggleBtn.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    motion = !(motion && !paused);
    paused = false;
    applyMotion();
    opts.onToggleMotion?.(motion);
  });
  toggleBtn.setAttribute('aria-label', '캠퍼스 애니메이션 켜기/끄기');
  root.appendChild(toggleBtn);

  container.replaceChildren(root);

  function applyMotion() {
    // 실제로 애니메이션을 트는지는 사용자 토글(motion/paused)뿐 아니라
    // 탭이 안 보이는 동안(hidden)과 OS의 '모션 감소' 선호도도 반영한다.
    // 단, 토글 버튼 라벨은 사용자가 고른 의도(motion/paused)만 보여준다.
    const hidden = typeof document !== 'undefined' && document.hidden;
    const reduced = !!reduceMotionQuery?.matches;
    const on = motion && !paused && !hidden && !reduced;
    root.dataset.motion = on ? 'on' : 'off';
    setToggleLabel();
  }

  const onVisibilityChange = () => applyMotion();
  const onReduceMotionChange = () => applyMotion();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
  reduceMotionQuery?.addEventListener?.('change', onReduceMotionChange);

  function applyState(next) {
    root.dataset.state = next;
  }

  applyMotion();
  applyState(state);

  return {
    setState(next, { holdMs } = {}) {
      if (!STATES.has(next)) return;
      // 같은 상태를 다시 요청받으면(주기적 refresh 등) 이미지를 다시 불러오거나
      // 재생 중인 애니메이션을 처음부터 다시 시작하지 않는다.
      if (next === state) {
        if (next === 'success' && holdMs && !successTimer) {
          successTimer = setTimeout(() => {
            successTimer = null;
            applyState(state === 'success' ? 'idle' : state);
          }, holdMs);
        }
        return;
      }
      state = next;
      if (successTimer) { clearTimeout(successTimer); successTimer = null; }
      applyState(state);
      if (next === 'success' && holdMs) {
        successTimer = setTimeout(() => {
          successTimer = null;
          applyState(state === 'success' ? 'idle' : state);
        }, holdMs);
      }
    },
    setMotion(on) {
      motion = on !== false;
      paused = false;
      applyMotion();
    },
    destroy() {
      if (successTimer) clearTimeout(successTimer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
      reduceMotionQuery?.removeEventListener?.('change', onReduceMotionChange);
      root.remove();
    },
  };
}
