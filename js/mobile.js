// Touch controls for the Android build only.
//
// The APK loads index.html?mobile=1, so a desktop run of the game never even
// installs this: initTouchControls returns null and nothing is added to the DOM.
// Everything it does is written into the same `pad` object the gamepad uses, so
// the game loop, the menu navigation and the HUD labels all keep working.

const ON = /(?:^|[?&])mobile=1(?:&|$)/;

export function initTouchControls({ pad, game }) {
  if (!ON.test(location.search)) return null;

  const style = document.createElement('style');
  style.textContent = `
    /* A drag must never be read as a page pan: that is what fires pointercancel
       and makes the stick drop out from under the thumb. */
    html, body { touch-action: none; overscroll-behavior: none; -webkit-user-select: none; user-select: none; }
    #app, #game { touch-action: none; }
    #touch-ui { position: fixed; inset: 0; z-index: 60; pointer-events: none; display: none; }
    #touch-ui.on { display: block; }
    #touch-stick {
      position: absolute; width: 132px; height: 132px; border-radius: 50%;
      border: 2px solid rgba(214, 240, 255, .3); background: rgba(8, 16, 24, .3);
      opacity: 0; transition: opacity .12s ease-out; left: 0; top: 0;
      transform: translate(-50%, -50%); backdrop-filter: blur(2px);
    }
    #touch-stick.vis { opacity: 1; }
    #touch-stick i {
      position: absolute; left: 50%; top: 50%; width: 58px; height: 58px;
      margin: -29px 0 0 -29px; border-radius: 50%;
      background: rgba(222, 244, 255, .55); box-shadow: 0 0 18px rgba(140, 220, 255, .45);
    }
    #touch-ui .touch-btn {
      position: absolute; pointer-events: auto; border-radius: 50%;
      border: 2px solid rgba(214, 240, 255, .32); background: rgba(10, 22, 32, .45);
      color: #dff3ff; font: 700 13px/1 ui-sans-serif, system-ui, sans-serif;
      letter-spacing: .1em; touch-action: none; user-select: none; -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    #touch-ui .touch-btn.down { background: rgba(120, 210, 255, .45); border-color: rgba(220, 245, 255, .8); }
    #touch-jump { right: 26px; bottom: 26px; width: 104px; height: 104px; }
    #touch-dash { right: 146px; bottom: 44px; width: 76px; height: 76px; font-size: 12px; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'touch-ui';
  root.innerHTML = `
    <div id="touch-stick"><i></i></div>
    <button id="touch-jump" class="touch-btn">JUMP</button>
    <button id="touch-dash" class="touch-btn">DASH</button>
  `;
  document.getElementById('app').appendChild(root);

  const stickEl = root.querySelector('#touch-stick');
  const knobEl = stickEl.querySelector('i');
  const jumpEl = root.querySelector('#touch-jump');
  const dashEl = root.querySelector('#touch-dash');

  const STICK_R = 66;
  const CAM_SPEED = 0.55; // pixels of drag -> stick deflection

  const stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
  const cam = { id: null, lx: 0, ly: 0, dx: 0, dy: 0 };
  let jumpQueued = false;
  let dashQueued = false;
  let jumpHeld = false;
  let dashHeld = false;

  // ---- left half: floating stick -------------------------------------------
  // Listening on the window, not the overlay: the overlay itself is
  // pointer-events:none so the canvas keeps focus and the game keeps its
  // context menu and scrolling behaviour in the WebView.
  window.addEventListener('pointerdown', (e) => {
    if (game.mode !== 'playing') return;
    if (e.target.closest && e.target.closest('.touch-btn')) return;
    const left = e.clientX < window.innerWidth * 0.5;
    if (left && stick.id === null) {
      stick.id = e.pointerId;
      stick.ox = e.clientX;
      stick.oy = e.clientY;
      stick.x = stick.y = 0;
      stickEl.style.left = `${e.clientX}px`;
      stickEl.style.top = `${e.clientY}px`;
      stickEl.classList.add('vis');
      knobEl.style.transform = 'translate(0px, 0px)';
    } else if (!left && cam.id === null) {
      cam.id = e.pointerId;
      cam.lx = e.clientX;
      cam.ly = e.clientY;
    }
  });

  window.addEventListener('pointermove', (e) => {
    if ((e.pointerId === stick.id || e.pointerId === cam.id) && e.cancelable) e.preventDefault();
    if (e.pointerId === stick.id) {
      let dx = e.clientX - stick.ox;
      let dy = e.clientY - stick.oy;
      const mag = Math.hypot(dx, dy);
      if (mag > STICK_R) {
        // Walk the ring along with the thumb instead of pinning the knob at the
        // rim: a long drag keeps full deflection and never runs out of travel.
        stick.ox += (dx / mag) * (mag - STICK_R);
        stick.oy += (dy / mag) * (mag - STICK_R);
        stickEl.style.left = `${stick.ox}px`;
        stickEl.style.top = `${stick.oy}px`;
        dx = (dx / mag) * STICK_R;
        dy = (dy / mag) * STICK_R;
      }
      stick.x = dx / STICK_R;
      stick.y = -dy / STICK_R; // up is forward
      knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
    } else if (e.pointerId === cam.id) {
      cam.dx += e.clientX - cam.lx;
      cam.dy += e.clientY - cam.ly;
      cam.lx = e.clientX;
      cam.ly = e.clientY;
    }
  });

  const release = (e) => {
    if (e.pointerId === stick.id) {
      stick.id = null;
      stick.x = stick.y = 0;
      stickEl.classList.remove('vis');
    }
    if (e.pointerId === cam.id) cam.id = null;
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);

  // ---- right corner: jump and dash -----------------------------------------
  const bindButton = (el, onDown, onUp) => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('down');
      onDown();
    });
    const up = (e) => {
      if (el.hasPointerCapture && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.classList.remove('down');
      onUp();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  bindButton(jumpEl, () => { jumpQueued = true; jumpHeld = true; }, () => { jumpHeld = false; });
  bindButton(dashEl, () => { dashQueued = true; dashHeld = true; }, () => { dashHeld = false; });

  // Nothing on the page should scroll, zoom or select under a thumb. Buttons are
  // left alone so their taps keep producing normal clicks in the menus.
  const noGesture = (e) => {
    if (game.mode !== 'playing') return;
    if (e.target.closest && e.target.closest('.touch-btn')) return;
    if (e.cancelable) e.preventDefault();
  };
  document.addEventListener('touchstart', noGesture, { passive: false });
  document.addEventListener('touchmove', noGesture, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    update(dt) {
      const playing = game.mode === 'playing';
      root.classList.toggle('on', playing);

      // The controller snapshot is empty when no gamepad is plugged in; claim the
      // pad for touch so movement, menus and the HUD labels keep behaving.
      pad.active = playing;

      if (!playing) {
        pad.moveX = pad.moveY = pad.camX = pad.camY = 0;
        cam.dx = cam.dy = 0;
        jumpQueued = dashQueued = jumpHeld = dashHeld = false;
        return;
      }

      pad.moveX = stick.x;
      pad.moveY = stick.y;

      // Drag on the right half orbits the camera, like the mouse does on desktop.
      pad.camX = Math.max(-1, Math.min(1, cam.dx * CAM_SPEED));
      pad.camY = Math.max(-1, Math.min(1, cam.dy * CAM_SPEED));
      cam.dx = cam.dy = 0;

      // One-frame edges, exactly what a pad button press produces.
      pad.jump = jumpQueued || false;
      pad.dash = dashQueued || false;
      jumpQueued = dashQueued = false;
      if (dt > 0 && jumpHeld) pad.prevJump = true; // holding must not re-fire
      if (dt > 0 && dashHeld) pad.prevDash = true;
    },
  };
}
