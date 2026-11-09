/* Kerf Studio — GRBL 1.1 connection over Web Serial with character-counting streaming. */
window.Kerf = window.Kerf || {};
(function (K) {
  'use strict';

  const ERRORS = {
    1: 'Expected command letter', 2: 'Bad number format', 3: 'Invalid $ statement', 4: 'Negative value',
    5: 'Homing not enabled', 6: 'Step pulse too short', 7: 'EEPROM read failed', 8: 'Machine not idle',
    9: 'Locked out during alarm or jog', 10: 'Soft limits need homing enabled', 11: 'Line too long',
    12: 'Step rate too high', 13: 'Safety door open', 14: 'Startup line too long', 15: 'Jog target exceeds travel',
    16: 'Invalid jog command', 17: 'Laser mode needs PWM output', 20: 'Unsupported G-code command',
    21: 'Two commands in the same modal group', 22: 'Feed rate not set', 23: 'Integer value required',
    24: 'Two commands need the same axis', 25: 'Repeated word', 26: 'No axis words', 27: 'Invalid line number',
    28: 'Missing value word', 29: 'Work coordinate systems not supported', 30: 'G53 needs G0/G1',
    31: 'Unused axis words', 32: 'Arc has no axis words in plane', 33: 'Invalid motion target',
    34: 'Invalid arc radius', 35: 'Missing arc offset', 36: 'Unused value words', 37: 'Tool offset axis error', 38: 'Tool number too high',
  };
  const ALARMS = {
    1: 'Hard limit triggered — re-home the machine', 2: 'Soft limit: job is outside the work area',
    3: 'Reset while moving — re-home recommended', 4: 'Probe fail', 5: 'Probe fail',
    6: 'Homing reset', 7: 'Homing: door opened', 8: 'Homing: could not clear limit switch',
    9: 'Homing: limit switch not found', 10: 'Homing failed',
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  class Grbl extends EventTarget {
    constructor() {
      super();
      this.port = null;
      this.connected = false;
      this.rxSize = 127;
      this.job = null;
      this.status = { state: 'Disconnected', mpos: [0, 0, 0], wpos: [0, 0, 0], wco: [0, 0, 0], feed: 0, power: 0 };
      this._enc = new TextEncoder();
      this._wchain = Promise.resolve();
      this._resetQueue();
    }
    get supported() { return 'serial' in navigator; }
    get busy() { return !!this.job || this.qi < this.q.length || this.inflight.length > 0; }

    _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    _log(type, text) { this._emit('log', { type, text }); }
    _resetQueue() { this.q = []; this.qi = 0; this.inflight = []; this.inflightBytes = 0; }

    async connect(baudRate) {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate, bufferSize: 8192 });
      this.port = port;
      this.connected = true;
      this._resetQueue();
      this.writer = port.writable.getWriter();
      this._wchain = Promise.resolve();
      this.status.state = 'Connecting';
      this._emit('status', this.status);
      this._readLoop();
      this._log('info', `Port opened at ${baudRate} baud`);
      await sleep(1200); // some controllers reboot when the port opens
      if (!this.connected) return;
      this._poll = setInterval(() => this.realtime('?'), 250);
      this._emit('connected');
    }

    async disconnect() {
      if (!this.port) return;
      clearInterval(this._poll);
      this.connected = false;
      const hadJob = !!this.job;
      this.job = null;
      try { await this.reader?.cancel(); } catch (e) { /* ignore */ }
      try { await this._readDone; } catch (e) { /* ignore */ }
      try { await this._wchain; } catch (e) { /* ignore */ }
      try { this.writer?.releaseLock(); } catch (e) { /* ignore */ }
      try { await this.port.close(); } catch (e) { /* ignore */ }
      this.port = null; this.writer = null; this.reader = null;
      this._resetQueue();
      this.status.state = 'Disconnected';
      this._emit('status', this.status);
      if (hadJob) this._emit('jobAborted', { reason: 'Disconnected' });
      this._emit('disconnected');
      this._log('info', 'Disconnected');
    }

    async _readLoop() {
      const dec = new TextDecoderStream();
      this._readDone = this.port.readable.pipeTo(dec.writable).catch(() => {});
      this.reader = dec.readable.getReader();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) this._onLine(line);
          }
        }
      } catch (e) { /* port lost */ }
      if (this.connected) {
        this._log('err', 'Connection lost');
        this.disconnect();
      }
    }

    _write(str) {
      const data = this._enc.encode(str);
      this._wchain = this._wchain
        .then(() => this.writer && this.writer.write(data))
        .catch(e => this._log('err', 'Write failed: ' + e.message));
      return this._wchain;
    }

    realtime(ch) { if (this.connected) this._write(ch); }

    send(line, src = 'user') {
      if (!this.connected) return false;
      line = String(line).replace(/;.*$/, '').trim();
      if (!line) return false;
      this.q.push({ line, src });
      this._pump();
      return true;
    }
    sendMany(lines, src = 'user') { for (const l of lines) this.send(l, src); }

    _pump() {
      while (this.qi < this.q.length) {
        const it = this.q[this.qi];
        const len = it.line.length + 1;
        if (this.inflight.length && this.inflightBytes + len > this.rxSize) break;
        this.qi++;
        it.len = len;
        this.inflight.push(it);
        this.inflightBytes += len;
        this._write(it.line + '\n');
        if (it.src === 'user') this._log('tx', it.line);
      }
      if (this.qi > 20000) { this.q = this.q.slice(this.qi); this.qi = 0; }
    }

    _onLine(line) {
      if (line[0] === '<') { this._parseStatus(line); return; }
      if (line === 'ok' || line.startsWith('error:')) {
        const it = this.inflight.shift();
        if (it) this.inflightBytes -= it.len;
        if (line !== 'ok') {
          const code = parseInt(line.slice(6), 10);
          this._log('err', `error:${code} ${ERRORS[code] || ''}${it ? '  ← ' + it.line : ''}`);
        } else if (it && it.src === 'user') this._log('ok', 'ok');
        if (it && it.src === 'job' && this.job) {
          this.job.acked++;
          if (this.job.acked >= this.job.total) {
            const j = this.job;
            this.job = null;
            this._emit('jobDone', { elapsed: (performance.now() - j.start) / 1000 });
          }
        }
        this._pump();
        return;
      }
      if (line.startsWith('ALARM:')) {
        const code = parseInt(line.slice(6), 10);
        this.status.state = 'Alarm';
        this._emit('status', this.status);
        this._log('err', `ALARM:${code} ${ALARMS[code] || ''}`);
        this._emit('alarm', { code, message: ALARMS[code] || 'Alarm' });
        if (this.job) { this.job = null; this._resetQueue(); this._emit('jobAborted', { reason: 'Alarm ' + code }); }
        return;
      }
      if (/^Grbl\s/i.test(line)) {
        const hadJob = !!this.job;
        this._resetQueue();
        this.job = null;
        if (hadJob) this._emit('jobAborted', { reason: 'Controller reset' });
        this._log('info', line);
        this._emit('banner', line);
        return;
      }
      const m = /^\$(\d+)=([-\d.]+)/.exec(line);
      if (m) this._emit('setting', { key: +m[1], value: parseFloat(m[2]) });
      this._log('rx', line);
    }

    _parseStatus(line) {
      const body = line.slice(1, line.lastIndexOf('>'));
      const parts = body.split('|');
      const st = this.status;
      st.state = parts[0].split(':')[0];
      st.sub = parts[0];
      let mpos = null, wpos = null;
      for (const p of parts.slice(1)) {
        const [k, v] = p.split(':');
        if (v === undefined) continue;
        const nums = v.split(',').map(Number);
        if (k === 'MPos') mpos = nums;
        else if (k === 'WPos') wpos = nums;
        else if (k === 'WCO') st.wco = nums;
        else if (k === 'FS') { st.feed = nums[0]; st.power = nums[1] || 0; }
        else if (k === 'F') st.feed = nums[0];
        else if (k === 'Ov') st.ov = nums;
      }
      if (mpos) { st.mpos = mpos; st.wpos = mpos.map((n, i) => n - (st.wco[i] || 0)); }
      else if (wpos) { st.wpos = wpos; st.mpos = wpos.map((n, i) => n + (st.wco[i] || 0)); }
      this._emit('status', st);
    }

    // ---- high level
    streamJob(lines) {
      const clean = lines.map(l => l.replace(/;.*$/, '').trim()).filter(Boolean);
      this.job = { total: clean.length, acked: 0, start: performance.now() };
      for (const l of clean) this.q.push({ line: l, src: 'job' });
      this._emit('jobStart', { total: clean.length });
      this._pump();
    }
    pause() { this.realtime('!'); }
    resume() { this.realtime('~'); }
    stop() {
      const hadJob = !!this.job;
      this._resetQueue();
      this.job = null;
      this.realtime('\x18');
      if (hadJob) this._emit('jobAborted', { reason: 'Stopped' });
    }
    jog(dx, dy, feed) {
      let cmd = '$J=G91 G21';
      if (dx) cmd += ' X' + K.gcode.fmt(dx);
      if (dy) cmd += ' Y' + K.gcode.fmt(dy);
      this.send(cmd + ' F' + Math.round(feed));
    }
    jogCancel() { this.realtime('\x85'); }
  }

  K.Grbl = Grbl;
})(window.Kerf);
