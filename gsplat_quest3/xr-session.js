// Session-owned input and tracking. No dependency on Three's controller slot cache.
// Each project keeps a local copy so it can be served independently on GitHub Pages.
export function localizedPose(pose) {
  return Boolean(pose && !pose.emulatedPosition && pose.transform?.matrix?.length === 16 &&
    Array.from(pose.transform.matrix).every(Number.isFinite));
}

export class XRSessionState {
  constructor(controllers, { suspend = () => {}, resume = () => {}, reset = () => {}, end = () => {}, log = () => {} } = {}) {
    this.controllers = controllers;
    this.callbacks = { suspend, resume, reset, end, log };
    this.session = null;
    this.tracked = false;
    this.cleanups = [];
    this.referenceCleanup = null;
    this.ready = new Set();
    this.actions = new Map();
    for (const c of controllers) c.visible = false;
  }
  listen(target, type, handler) {
    target.addEventListener(type, handler);
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }
  attach(session) {
    this.detach();
    this.session = session;
    this.pausedTotal = 0;
    this.pausedAt = performance.now();
    this.listen(session, 'visibilitychange', () => {
      this.callbacks.log('visibility', { state: session.visibilityState });
      // Even returning to visible requires a fresh, positional viewer pose.
      this.suspend('visibility ' + session.visibilityState);
    });
    this.listen(session, 'inputsourceschange', event => {
      this.callbacks.log('sources_changed', { added: event.added?.length, removed: event.removed?.length });
      this.reconcile();
    });
    this.listen(session, 'end', () => {
      this.suspend('session end');
      this.detach();
      // Three must finish restoring its framebuffer before desktop rendering resumes.
      queueMicrotask(() => this.callbacks.end(session));
    });
    for (const type of ['selectstart', 'selectend', 'select', 'squeezestart', 'squeezeend', 'squeeze']) {
      this.listen(session, type, event => this.input(type, event));
    }
    this.reconcile();
  }
  bindReference(reference) {
    this.referenceCleanup?.();
    const onReset = () => {
      this.suspend('reference reset');
      this.callbacks.log('reference_reset', {});
      this.callbacks.reset();
    };
    reference.addEventListener('reset', onReset);
    this.referenceCleanup = () => reference.removeEventListener('reset', onReset);
    this.reference = reference;
  }
  detach() {
    this.cleanups.splice(0).forEach(dispose => dispose());
    this.referenceCleanup?.(); this.referenceCleanup = null; this.reference = null;
    this.session = null; this.tracked = false;
    this.ready.clear(); this.actions.clear();
    for (const c of this.controllers) this.disconnect(c);
  }
  disconnect(c) {
    const source = c.userData.source;
    c.visible = false;
    if (source) {
      this.callbacks.log('source_unbound', { hand: source.handedness, handTracking: Boolean(source.hand) });
      this.ready.delete(source); this.actions.delete(source);
      c.dispatchEvent({ type: 'disconnected', data: source });
    }
    c.userData.source = null; c.userData.handedness = null;
  }
  reconcile() {
    const sources = Array.from(this.session?.inputSources || []).filter(s => s.targetRaySpace);
    // Source identity, not array order or handedness, owns a slot until removal.
    for (const c of this.controllers) if (!sources.includes(c.userData.source)) this.disconnect(c);
    for (const source of sources) {
      if (this.controllers.some(c => c.userData.source === source)) continue;
      const c = this.controllers.find(c => !c.userData.source);
      if (!c) continue;
      c.userData.source = source; c.userData.handedness = source.handedness;
      c.visible = false;
      c.dispatchEvent({ type: 'connected', data: source });
      this.callbacks.log('source_bound', { hand: source.handedness, handTracking: Boolean(source.hand) });
    }
  }
  suspend(reason) {
    if (this.pausedAt == null) this.pausedAt = performance.now();
    const changed = this.tracked || this.reason !== reason;
    this.tracked = false; this.reason = reason;
    this.ready.clear(); this.actions.clear();
    for (const c of this.controllers) {
      if (c.visible) c.dispatchEvent({ type: 'trackinglost' });
      c.visible = false;
    }
    // A visibility event can be the last callback before XR frames stop entirely.
    if (changed) { this.callbacks.log('suspended', { reason }); this.callbacks.suspend(reason); }
  }
  now() {
    return this.session ? (this.pausedAt ?? performance.now()) - this.pausedTotal : performance.now();
  }
  poseController(c, frame, reference) {
    const pose = frame.getPose(c.userData.source.targetRaySpace, reference);
    if (!localizedPose(pose)) {
      this.ready.delete(c.userData.source); this.actions.delete(c.userData.source);
      if (c.visible) c.dispatchEvent({ type: 'trackinglost' });
      c.visible = false;
      return false;
    }
    c.matrix.fromArray(pose.transform.matrix);
    c.matrix.decompose(c.position, c.quaternion, c.scale);
    c.updateMatrixWorld(true); c.visible = true;
    return true;
  }
  update(frame, reference) {
    this.reconcile();
    const session = this.session;
    if (!session || frame?.session !== session || !reference || session.visibilityState !== 'visible') {
      this.suspend('frame unavailable or hidden'); return null;
    }
    const viewer = frame.getViewerPose(reference);
    if (!localizedPose(viewer)) { this.suspend('positional tracking unavailable'); return null; }
    const resuming = !this.tracked;
    this.tracked = true; this.reason = null;
    for (const c of this.controllers) {
      const source = c.userData.source;
      if (!source || !this.poseController(c, frame, reference)) continue;
      // Prevent a held trigger/stick/button from activating after resume/hotplug.
      if (!source.gamepad || (source.gamepad.buttons.every(b => !b.pressed) &&
          source.gamepad.axes.every(a => Math.abs(a) < 0.2))) this.ready.add(source);
    }
    if (resuming) {
      const pausedMs = this.pausedAt == null ? 0 : performance.now() - this.pausedAt;
      this.pausedTotal += pausedMs;
      this.pausedAt = null;
      this.callbacks.log('resumed', { pausedMs, sources: this.controllers.filter(c => c.visible).length });
      this.callbacks.resume(pausedMs);
    }
    return viewer;
  }
  input(type, event) {
    const source = event.inputSource, session = this.session;
    const c = this.controllers.find(c => c.userData.source === source);
    if (!session || session.visibilityState !== 'visible' || !this.tracked || !c ||
        !this.ready.has(source) || !Array.from(session.inputSources).includes(source) ||
        event.frame?.session !== session || !this.reference || !this.poseController(c, event.frame, this.reference)) {
      this.callbacks.log('input_ignored', { type, hand: source?.handedness, tracked: this.tracked,
        visibility: session?.visibilityState, ready: this.ready.has(source) });
      return;
    }
    let actions = this.actions.get(source);
    if (!actions) this.actions.set(source, actions = new Set());
    const action = type.startsWith('select') ? 'select' : 'squeeze';
    if (type.endsWith('start')) {
      if (actions.has(action)) return;
      actions.add(action);
    } else {
      // Ignore release/completion of a gesture that began before a suspension.
      if (!actions.has(action)) return;
      // WebXR sends select/end in implementation-dependent adjacent callbacks.
      if (type.endsWith('end')) queueMicrotask(() => actions.delete(action));
    }
    c.dispatchEvent({ type, data: source });
  }
}
