window.addEventListener("DOMContentLoaded", () => {
  const recordBtn = document.getElementById("recordBtn");
  const stopBtn = document.getElementById("stopBtn");
  const playBtn = document.getElementById("playBtn");
  const loopBtn = document.getElementById("loopBtn");
  const midiBtn = document.getElementById("midiBtn");
  const wavBtn = document.getElementById("wavBtn");
  const jsonBtn = document.getElementById("jsonBtn");

  const soundSelect = document.getElementById("soundSelect");
  const snapToggle = document.getElementById("snapToggle");
  const tightToggle = document.getElementById("tightToggle");
  const octaveShift = document.getElementById("octaveShift");
  const jimToggle = document.getElementById("jimToggle");

  const keyMode = document.getElementById("keyMode");
  const keyRoot = document.getElementById("keyRoot");
  const keyScale = document.getElementById("keyScale");
  const detectedKeyText = document.getElementById("detectedKeyText");

  const statusEl = document.getElementById("status");
  const metaEl = document.getElementById("meta");
  const noteList = document.getElementById("noteList");

  const canvas = document.getElementById("waveCanvas");
  const ctx = canvas.getContext("2d");

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

  let audioContext = null;
  let analyser = null;
  let mediaStream = null;
  let sourceNode = null;
  let captureTimer = null;
  let drawHandle = null;

  let isRecording = false;
  let isLooping = false;
  let rawFrames = [];
  let riffNotes = [];
  let liveWave = new Float32Array(2048);
  let detectedKey = null;
  let loopTimeout = null;
  let transportItems = [];

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setMeta(text) {
    metaEl.textContent = text;
  }

  function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function updateDetectedKeyText() {
    if (keyMode.value === "off") {
      detectedKeyText.textContent = "Key help off";
      return;
    }

    if (keyMode.value === "manual") {
      detectedKeyText.textContent = `${NOTE_NAMES[Number(keyRoot.value)]} ${capitalize(keyScale.value)}`;
      return;
    }

    if (!detectedKey) {
      detectedKeyText.textContent = "Listening…";
      return;
    }

    detectedKeyText.textContent = `${NOTE_NAMES[detectedKey.root]} ${capitalize(detectedKey.scale)}`;
  }

  function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  function noteNameFromMidi(midi) {
    const note = NOTE_NAMES[((midi % 12) + 12) % 12];
    const octave = Math.floor(midi / 12) - 1;
    return `${note}${octave}`;
  }

  function rms(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }

  function averageAbs(buffer) {
    let total = 0;
    for (let i = 0; i < buffer.length; i++) total += Math.abs(buffer[i]);
    return total / buffer.length;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function clampBassRange(midi) {
    let value = midi;
    while (value > 52) value -= 12;
    while (value < 28) value += 12;
    return value;
  }

  function autoCorrelate(buffer, sampleRate) {
    const level = rms(buffer);
    const minLevel = jimToggle.checked ? 0.02 : 0.015;
    if (level < minLevel) return null;

    let bestOffset = -1;
    let bestCorrelation = 0;

    const minFreq = 55;
    const maxFreq = 650;
    const minOffset = Math.floor(sampleRate / maxFreq);
    const maxOffset = Math.floor(sampleRate / minFreq);

    for (let offset = minOffset; offset <= maxOffset; offset++) {
      let correlation = 0;
      for (let i = 0; i < buffer.length - offset; i++) {
        correlation += 1 - Math.abs(buffer[i] - buffer[i + offset]);
      }
      correlation /= (buffer.length - offset);

      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestOffset = offset;
      }
    }

    const minCorrelation = jimToggle.checked ? 0.9 : 0.87;
    if (bestCorrelation > minCorrelation && bestOffset > 0) {
      return sampleRate / bestOffset;
    }

    return null;
  }

  function drawWave() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = (canvas.height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 2.6;
    ctx.beginPath();

    for (let i = 0; i < liveWave.length; i++) {
      const x = (i / liveWave.length) * canvas.width;
      const y = canvas.height / 2 + liveWave[i] * (canvas.height * 0.32);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.stroke();
    drawHandle = requestAnimationFrame(drawWave);
  }

  function renderNotes(notes) {
    if (!notes.length) {
      noteList.textContent = "Nothing yet.";
      setMeta("No riff captured yet.");
      return;
    }

    noteList.innerHTML = notes
      .map(n => `<span class="note-chip">${n.note} · ${n.duration.toFixed(2)}s</span>`)
      .join("");

    const total = Math.max(...notes.map(n => n.start + n.duration));
    setMeta(`Riff length: ${total.toFixed(2)}s · ${notes.length} notes`);
  }

  function stopLiveAudio() {
    if (captureTimer) {
      clearInterval(captureTimer);
      captureTimer = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
    }

    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (e) {}
      sourceNode = null;
    }

    analyser = null;
  }

  function getScalePitchClasses(root, scaleName) {
    const scale = scaleName === "major" ? MAJOR_SCALE : MINOR_SCALE;
    return scale.map(interval => (root + interval) % 12);
  }

  function nearestMidiInScale(midiFloat, root, scaleName) {
    const allowed = getScalePitchClasses(root, scaleName);
    let bestMidi = Math.round(midiFloat);
    let bestDistance = Infinity;

    for (let candidate = Math.floor(midiFloat) - 12; candidate <= Math.ceil(midiFloat) + 12; candidate++) {
      const pc = ((candidate % 12) + 12) % 12;
      if (!allowed.includes(pc)) continue;

      const distance = Math.abs(candidate - midiFloat);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMidi = candidate;
      }
    }

    return bestMidi;
  }

  function scoreKeyFit(midiFloats, root, scaleName) {
    const allowed = getScalePitchClasses(root, scaleName);
    let score = 0;

    for (const value of midiFloats) {
      const rounded = Math.round(value);
      const pc = ((rounded % 12) + 12) % 12;

      if (allowed.includes(pc)) {
        score += 2;
      } else {
        let nearestDistance = Infinity;
        for (let candidate = rounded - 2; candidate <= rounded + 2; candidate++) {
          const cpc = ((candidate % 12) + 12) % 12;
          if (!allowed.includes(cpc)) continue;
          nearestDistance = Math.min(nearestDistance, Math.abs(candidate - value));
        }
        score -= nearestDistance;
      }
    }

    return score;
  }

  function detectBestKey(midiFloats) {
    if (!midiFloats.length) return null;

    let best = null;
    for (let root = 0; root < 12; root++) {
      for (const scaleName of ["major", "minor"]) {
        const score = scoreKeyFit(midiFloats, root, scaleName);
        if (!best || score > best.score) {
          best = { root, scale: scaleName, score };
        }
      }
    }
    return best;
  }

  function getActiveKey(midiFloats) {
    if (keyMode.value === "off") return null;

    if (keyMode.value === "manual") {
      return {
        root: Number(keyRoot.value),
        scale: keyScale.value
      };
    }

    detectedKey = detectBestKey(midiFloats);
    updateDetectedKeyText();
    return detectedKey;
  }

  function buildRiff(frames) {
    if (!frames.length) return [];

    const octaveAdjust = Number(octaveShift.value);

    const voiced = frames.map(frame => {
      if (!frame.freq) return { ...frame, voiced: false };
      const shifted = frame.freq * Math.pow(2, octaveAdjust / 12);
      return {
        time: frame.time,
        amp: frame.amp,
        voiced: true,
        midiFloat: freqToMidi(shifted)
      };
    });

    const smoothed = [];
    const smoothing = jimToggle.checked ? 4 : 2;

    for (let i = 0; i < voiced.length; i++) {
      const slice = voiced
        .slice(Math.max(0, i - smoothing), Math.min(voiced.length, i + smoothing + 1))
        .filter(v => v.voiced);

      smoothed.push({
        ...voiced[i],
        midiFloat: slice.length ? median(slice.map(v => v.midiFloat)) : null
      });
    }

    const allMidiFloats = smoothed
      .filter(frame => frame.voiced && frame.midiFloat != null)
      .map(frame => frame.midiFloat);

    const activeKey = getActiveKey(allMidiFloats);

    const grouped = [];
    let current = null;
    let silenceFrames = 0;

    for (const frame of smoothed) {
      if (!frame.voiced || frame.midiFloat == null) {
        silenceFrames++;
        if (current && silenceFrames >= (jimToggle.checked ? 3 : 2)) {
          current.end = frame.time;
          grouped.push(current);
          current = null;
        }
        continue;
      }

      silenceFrames = 0;

      let midiValue;
      if (snapToggle.checked) {
        midiValue = activeKey
          ? nearestMidiInScale(frame.midiFloat, activeKey.root, activeKey.scale)
          : Math.round(frame.midiFloat);
      } else {
        midiValue = Math.round(frame.midiFloat);
      }

      if (!current) {
        current = {
          start: frame.time,
          end: frame.time + 0.06,
          values: [midiValue]
        };
        continue;
      }

      const currentMedian = median(current.values);
      const tolerance = jimToggle.checked ? 2.0 : (snapToggle.checked ? 1.2 : 1.8);

      if (Math.abs(midiValue - currentMedian) <= tolerance) {
        current.end = frame.time + 0.06;
        current.values.push(midiValue);
      } else {
        grouped.push(current);
        current = {
          start: frame.time,
          end: frame.time + 0.06,
          values: [midiValue]
        };
      }
    }

    if (current) grouped.push(current);

    let cleaned = grouped
      .map(group => {
        const mid = median(group.values);
        let finalMidi = Math.round(mid);

        if (snapToggle.checked && activeKey) {
          finalMidi = nearestMidiInScale(mid, activeKey.root, activeKey.scale);
        }

        return {
          start: group.start,
          duration: Math.max(jimToggle.checked ? 0.12 : 0.08, group.end - group.start),
          midi: clampBassRange(finalMidi)
        };
      })
      .filter(note => note.duration >= (jimToggle.checked ? 0.12 : 0.1));

    if (!cleaned.length) return [];

    if (tightToggle.checked) {
      const shortest = Math.max(jimToggle.checked ? 0.14 : 0.12, Math.min(...cleaned.map(n => n.duration)));
      const grid = shortest < 0.18 ? 0.125 : 0.25;

      cleaned = cleaned.map(note => {
        const start = Math.round(note.start / grid) * grid;
        let duration = Math.round(note.duration / grid) * grid;
        if (duration < grid) duration = grid;
        return { ...note, start, duration };
      });
    } else {
      cleaned = cleaned.map(note => ({
        ...note,
        start: Number(note.start.toFixed(3)),
        duration: Number(note.duration.toFixed(3))
      }));
    }

    cleaned.sort((a, b) => a.start - b.start);

    return cleaned.map(note => ({
      ...note,
      note: noteNameFromMidi(note.midi),
      velocity: 0.92
    }));
  }

  function refreshButtons(hasNotes) {
    playBtn.disabled = !hasNotes;
    loopBtn.disabled = !hasNotes;
    midiBtn.disabled = !hasNotes;
    wavBtn.disabled = !hasNotes;
    jsonBtn.disabled = !hasNotes;
  }

  async function startRecording() {
    try {
      setStatus(jimToggle.checked ? "Starting mic… Jim Mode armed 🎧" : "Starting mic…");
      ensureAudioContext();

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      if (window.Tone && Tone.start) {
        await Tone.start();
      }

      stopPlayback();
      stopLiveAudio();

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = jimToggle.checked ? 0.9 : 0.82;

      sourceNode = audioContext.createMediaStreamSource(mediaStream);

      const highpass = audioContext.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = jimToggle.checked ? 70 : 50;

      const lowpass = audioContext.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = jimToggle.checked ? 1200 : 1500;

      sourceNode.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(analyser);

      rawFrames = [];
      riffNotes = [];
      detectedKey = null;
      updateDetectedKeyText();
      renderNotes([]);

      recordBtn.disabled = true;
      stopBtn.disabled = false;
      refreshButtons(false);

      isRecording = true;
      isLooping = false;
      loopBtn.textContent = "🔁 Loop Off";

      const buffer = new Float32Array(analyser.fftSize);
      const startedAt = performance.now();

      captureTimer = setInterval(() => {
        if (!isRecording || !analyser) return;

        analyser.getFloatTimeDomainData(buffer);
        liveWave = new Float32Array(buffer);

        const freq = autoCorrelate(buffer, audioContext.sampleRate);
        const time = (performance.now() - startedAt) / 1000;
        const amp = averageAbs(buffer);

        rawFrames.push({ time, freq, amp });
      }, jimToggle.checked ? 60 : 55);

      setStatus(jimToggle.checked ? "Recording… Jim is listening 🎧" : "Recording… hum away.");
      setMeta("Tap Stop when the riff is done.");
    } catch (err) {
      console.error(err);
      setStatus("Mic access failed.");
      setMeta("Allow microphone permission and make sure the site is on GitHub Pages HTTPS.");
      stopLiveAudio();
      recordBtn.disabled = false;
      stopBtn.disabled = true;
      isRecording = false;
    }
  }

  function stopRecording() {
    isRecording = false;
    stopBtn.disabled = true;
    recordBtn.disabled = false;

    stopLiveAudio();

    riffNotes = buildRiff(rawFrames);
    renderNotes(riffNotes);

    const hasNotes = riffNotes.length > 0;
    refreshButtons(hasNotes);

    if (hasNotes) {
      setStatus(jimToggle.checked ? "Riff captured. Jim approves." : "Riff captured. Give it a spin.");
    } else {
      setStatus("No clear riff detected.");
      setMeta("Try a cleaner hum with tiny pauses between notes.");
    }

    updateDetectedKeyText();
  }

  function createBassSynth() {
    const filter = new Tone.Filter(jimToggle.checked ? 1400 : 1600, "lowpass").toDestination();
    const comp = new Tone.Compressor({
      threshold: -20,
      ratio: jimToggle.checked ? 4 : 3,
      attack: 0.01,
      release: 0.2
    }).connect(filter);
    const gain = new Tone.Gain(jimToggle.checked ? 1.0 : 0.9).connect(comp);

    let synth;

    if (soundSelect.value === "picked") {
      synth = new Tone.MonoSynth({
        oscillator: { type: "square" },
        envelope: {
          attack: 0.003,
          decay: 0.12,
          sustain: 0.15,
          release: 0.12
        },
        filterEnvelope: {
          attack: 0.001,
          decay: 0.15,
          sustain: 0.18,
          release: 0.14,
          baseFrequency: 120,
          octaves: 2.4
        }
      }).connect(gain);
    } else if (soundSelect.value === "synth") {
      synth = new Tone.MonoSynth({
        oscillator: { type: "sawtooth" },
        envelope: {
          attack: 0.01,
          decay: 0.22,
          sustain: 0.28,
          release: 0.22
        },
        filterEnvelope: {
          attack: 0.01,
          decay: 0.2,
          sustain: 0.3,
          release: 0.25,
          baseFrequency: 90,
          octaves: 2.8
        }
      }).connect(gain);
    } else {
      synth = new Tone.MonoSynth({
        oscillator: { type: "triangle" },
        envelope: {
          attack: 0.008,
          decay: 0.18,
          sustain: 0.42,
          release: 0.18
        },
        filterEnvelope: {
          attack: 0.005,
          decay: 0.16,
          sustain: 0.35,
          release: 0.2,
          baseFrequency: 85,
          octaves: 2.1
        }
      }).connect(gain);
    }

    return { synth, filter, comp, gain };
  }

  function stopPlayback() {
    clearTimeout(loopTimeout);
    if (window.Tone && Tone.Transport) {
      Tone.Transport.stop();
      Tone.Transport.cancel();
    }
    transportItems = [];
  }

  async function playRiff(loop = false) {
    if (!riffNotes.length) return;

    await Tone.start();
    stopPlayback();

    const chain = createBassSynth();
    const total = Math.max(...riffNotes.map(note => note.start + note.duration)) + 0.15;

    riffNotes.forEach(note => {
      const id = Tone.Transport.schedule((time) => {
        chain.synth.triggerAttackRelease(note.note, note.duration, time, note.velocity);
      }, note.start);
      transportItems.push(id);
    });

    Tone.Transport.start();
    setStatus(loop ? "Looping…" : "Playing…");

    if (loop) {
      loopTimeout = setTimeout(() => {
        if (isLooping) playRiff(true);
      }, total * 1000);
    } else {
      loopTimeout = setTimeout(() => {
        setStatus("Playback finished.");
      }, total * 1000);
    }
  }

  function writeVarLen(value) {
    let buffer = value & 0x7f;
    const bytes = [];
    while ((value >>= 7)) {
      buffer <<= 8;
      buffer |= (value & 0x7f) | 0x80;
    }
    while (true) {
      bytes.push(buffer & 0xff);
      if (buffer & 0x80) buffer >>= 8;
      else break;
    }
    return bytes;
  }

  function exportMIDI() {
    if (!riffNotes.length) return;

    const tpqn = 480;
    const tempo = 500000;
    const track = [];

    track.push(0x00, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);

    let previousTick = 0;

    riffNotes.forEach(note => {
      const startTick = Math.round(note.start * 2 * tpqn);
      const durTick = Math.max(60, Math.round(note.duration * 2 * tpqn));

      track.push(...writeVarLen(startTick - previousTick), 0x90, note.midi, 100);
      track.push(...writeVarLen(durTick), 0x80, note.midi, 0x00);

      previousTick = startTick + durTick;
    });

    track.push(0x00, 0xff, 0x2f, 0x00);

    const header = [
      0x4d, 0x54, 0x68, 0x64,
      0x00, 0x00, 0x00, 0x06,
      0x00, 0x00,
      0x00, 0x01,
      (tpqn >> 8) & 0xff, tpqn & 0xff
    ];

    const trackHeader = [
      0x4d, 0x54, 0x72, 0x6b,
      (track.length >> 24) & 0xff,
      (track.length >> 16) & 0xff,
      (track.length >> 8) & 0xff,
      track.length & 0xff
    ];

    const bytes = new Uint8Array([...header, ...trackHeader, ...track]);
    downloadBlob(new Blob([bytes], { type: "audio/midi" }), "hum-to-bass.mid");
  }

  function renderBassWavPCM(sampleRate = 44100) {
    if (!riffNotes.length) return null;

    const total = Math.max(...riffNotes.map(n => n.start + n.duration)) + 0.4;
    const length = Math.ceil(total * sampleRate);
    const data = new Float32Array(length);

    for (const note of riffNotes) {
      const freq = midiToFreq(note.midi);
      const startIndex = Math.floor(note.start * sampleRate);
      const durationSamples = Math.floor(note.duration * sampleRate);

      for (let i = 0; i < durationSamples; i++) {
        const idx = startIndex + i;
        if (idx >= length) break;

        const t = i / sampleRate;
        const attack = Math.min(1, i / (sampleRate * 0.008));
        const release = Math.min(1, (durationSamples - i) / (sampleRate * 0.05));
        const env = Math.max(0, Math.min(attack, release));

        let sample;
        if (soundSelect.value === "picked") {
          sample =
            Math.sign(Math.sin(2 * Math.PI * freq * t)) * 0.46 +
            Math.sin(2 * Math.PI * freq * 2 * t) * 0.10 +
            Math.sin(2 * Math.PI * freq * 3 * t) * 0.06;
        } else if (soundSelect.value === "synth") {
          sample =
            (2 * ((freq * t) % 1) - 1) * 0.55 +
            Math.sin(2 * Math.PI * freq * 0.5 * t) * 0.14;
        } else {
          sample =
            Math.sin(2 * Math.PI * freq * t) * 0.72 +
            Math.sin(2 * Math.PI * freq * 2 * t) * 0.16 +
            Math.sin(2 * Math.PI * freq * 3 * t) * 0.05;
        }

        const pluck = Math.exp(-t * 28) * (Math.random() * 2 - 1) * 0.03;
        data[idx] += (sample + pluck) * env * 0.33;
      }
    }

    for (let i = 1; i < data.length; i++) {
      data[i] = data[i] + data[i - 1] * 0.28;
    }

    return { sampleRate, data };
  }

  function floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return view;
  }

  function encodeWav(samples, sampleRate) {
    const bytesPerSample = 2;
    const numChannels = 1;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * bytesPerSample;

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    const pcm = floatTo16BitPCM(samples);
    for (let i = 0; i < dataSize; i++) {
      view.setUint8(44 + i, pcm.getUint8(i));
    }

    return new Blob([view], { type: "audio/wav" });
  }

  function exportWAV() {
    const rendered = renderBassWavPCM();
    if (!rendered) return;
    const wav = encodeWav(rendered.data, rendered.sampleRate);
    downloadBlob(wav, "hum-to-bass.wav");
  }

  function exportJSON() {
    if (!riffNotes.length) return;

    const payload = {
      createdAt: new Date().toISOString(),
      settings: {
        sound: soundSelect.value,
        correctPitch: snapToggle.checked,
        tightenRhythm: tightToggle.checked,
        octaveShift: Number(octaveShift.value),
        jimMode: jimToggle.checked,
        keyMode: keyMode.value,
        keyRoot: Number(keyRoot.value),
        keyScale: keyScale.value,
        detectedKey
      },
      notes: riffNotes
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });

    downloadBlob(blob, "hum-to-bass-riff.json");
  }

  function refreshFromSettings() {
    if (!rawFrames.length || isRecording) return;

    riffNotes = buildRiff(rawFrames);
    renderNotes(riffNotes);
    refreshButtons(riffNotes.length > 0);

    if (riffNotes.length > 0) {
      setStatus(jimToggle.checked ? "Riff updated. Jim Mode on." : "Riff updated.");
    }

    updateDetectedKeyText();
  }

  recordBtn.addEventListener("click", startRecording);
  stopBtn.addEventListener("click", stopRecording);

  playBtn.addEventListener("click", async () => {
    isLooping = false;
    loopBtn.textContent = "🔁 Loop Off";
    await playRiff(false);
  });

  loopBtn.addEventListener("click", async () => {
    isLooping = !isLooping;
    loopBtn.textContent = isLooping ? "🔁 Loop On" : "🔁 Loop Off";
    stopPlayback();

    if (isLooping) {
      await playRiff(true);
    } else {
      setStatus("Loop stopped.");
    }
  });

  midiBtn.addEventListener("click", exportMIDI);
  wavBtn.addEventListener("click", exportWAV);
  jsonBtn.addEventListener("click", exportJSON);

  [snapToggle, tightToggle, octaveShift, jimToggle, keyMode, keyRoot, keyScale].forEach(el => {
    el.addEventListener("change", () => {
      if (el === jimToggle) {
        setStatus(jimToggle.checked ? "Jim Mode activated 🎧" : "Standard capture");
      }
      updateDetectedKeyText();
      refreshFromSettings();
    });
  });

  soundSelect.addEventListener("change", () => {
    if (riffNotes.length) setStatus("Sound changed.");
  });

  window.addEventListener("beforeunload", () => {
    stopPlayback();
    stopLiveAudio();
    if (drawHandle) cancelAnimationFrame(drawHandle);
  });

  updateDetectedKeyText();
  drawWave();
});
