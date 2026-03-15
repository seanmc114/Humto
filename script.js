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

const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const noteList = document.getElementById("noteList");

const canvas = document.getElementById("waveCanvas");
const ctx = canvas.getContext("2d");

let audioContext = null;
let analyser = null;
let mediaStream = null;
let sourceNode = null;

let drawHandle = null;
let captureInterval = null;

let isRecording = false;
let isLooping = false;
let riffNotes = [];
let rawFrames = [];
let liveWave = new Float32Array(2048);

let bassChain = null;
let currentLoopTimeout = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setMeta(text) {
  metaEl.textContent = text;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

function noteNameFromMidi(midi) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const note = names[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

function averageAbs(buffer) {
  let total = 0;
  for (let i = 0; i < buffer.length; i++) total += Math.abs(buffer[i]);
  return total / buffer.length;
}

function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function autoCorrelate(buf, sampleRate) {
  const level = rms(buf);
  if (level < 0.015) return null;

  let bestOffset = -1;
  let bestCorrelation = 0;

  const minFreq = 55;
  const maxFreq = 650;
  const minOffset = Math.floor(sampleRate / maxFreq);
  const maxOffset = Math.floor(sampleRate / minFreq);

  for (let offset = minOffset; offset <= maxOffset; offset++) {
    let corr = 0;
    for (let i = 0; i < buf.length - offset; i++) {
      corr += 1 - Math.abs(buf[i] - buf[i + offset]);
    }
    corr /= (buf.length - offset);

    if (corr > bestCorrelation) {
      bestCorrelation = corr;
      bestOffset = offset;
    }
  }

  if (bestCorrelation > 0.87 && bestOffset > 0) {
    return sampleRate / bestOffset;
  }

  return null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clampBassRange(midi) {
  let m = midi;
  while (m > 52) m -= 12;
  while (m < 28) m += 12;
  return m;
}

function drawWave() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = (canvas.height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(96,165,250,0.95)";
  ctx.lineWidth = 2.4;
  ctx.beginPath();

  for (let i = 0; i < liveWave.length; i++) {
    const x = (i / liveWave.length) * canvas.width;
    const y = canvas.height / 2 + liveWave[i] * (canvas.height * 0.33);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  drawHandle = requestAnimationFrame(drawWave);
}

function renderNotes(notes) {
  if (!notes.length) {
    noteList.textContent = "Nothing yet.";
    return;
  }

  noteList.innerHTML = notes
    .map(n => `<span class="note-chip">${n.note} · ${n.duration.toFixed(2)}s</span>`)
    .join("");

  const total = Math.max(...notes.map(n => n.start + n.duration));
  setMeta(`Riff length: ${total.toFixed(2)}s · ${notes.length} notes`);
}

function stopLiveAudio() {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (_) {}
    sourceNode = null;
  }

  analyser = null;
}

function buildRiff(frames) {
  if (!frames.length) return [];

  const octaveAdjust = Number(octaveShift.value);

  const voiced = frames.map(f => {
    if (!f.freq) return { ...f, voiced: false };
    const shifted = f.freq * Math.pow(2, octaveAdjust / 12);
    return {
      time: f.time,
      amp: f.amp,
      voiced: true,
      freq: shifted,
      midiFloat: freqToMidi(shifted)
    };
  });

  const smoothed = [];
  for (let i = 0; i < voiced.length; i++) {
    const slice = voiced.slice(Math.max(0, i - 2), Math.min(voiced.length, i + 3)).filter(v => v.voiced);
    const med = slice.length ? median(slice.map(v => v.midiFloat)) : null;
    smoothed.push({
      ...voiced[i],
      midiFloat: med
    });
  }

  const notes = [];
  let current = null;
  let silenceFrames = 0;

  for (let i = 0; i < smoothed.length; i++) {
    const frame = smoothed[i];

    if (!frame.voiced || frame.midiFloat == null) {
      silenceFrames++;
      if (current && silenceFrames >= 2) {
        current.end = frame.time;
        notes.push(current);
        current = null;
      }
      continue;
    }

    silenceFrames = 0;

    const midiValue = snapToggle.checked
      ? Math.round(frame.midiFloat)
      : frame.midiFloat;

    if (!current) {
      current = {
        start: frame.time,
        end: frame.time + 0.06,
        values: [midiValue]
      };
      continue;
    }

    const currentMedian = median(current.values);
    const tolerance = snapToggle.checked ? 1.1 : 1.8;

    if (Math.abs(midiValue - currentMedian) <= tolerance) {
      current.end = frame.time + 0.06;
      current.values.push(midiValue);
    } else {
      notes.push(current);
      current = {
        start: frame.time,
        end: frame.time + 0.06,
        values: [midiValue]
      };
    }
  }

  if (current) notes.push(current);

  let cleaned = notes
    .map(n => {
      const mid = median(n.values);
      const rounded = snapToggle.checked ? Math.round(mid) : Math.round(mid);
      return {
        start: n.start,
        duration: Math.max(0.08, n.end - n.start),
        midi: clampBassRange(rounded)
      };
    })
    .filter(n => n.duration >= 0.10);

  if (!cleaned.length) return [];

  if (tightToggle.checked) {
    const shortest = Math.max(0.12, Math.min(...cleaned.map(n => n.duration)));
    const grid = shortest < 0.18 ? 0.125 : 0.25;

    cleaned = cleaned.map(n => {
      const start = Math.round(n.start / grid) * grid;
      let duration = Math.round(n.duration / grid) * grid;
      if (duration < grid) duration = grid;
      return { ...n, start, duration };
    });
  } else {
    cleaned = cleaned.map(n => ({
      ...n,
      start: Number(n.start.toFixed(3)),
      duration: Number(n.duration.toFixed(3))
    }));
  }

  cleaned.sort((a, b) => a.start - b.start);

  cleaned = cleaned.map(n => ({
    ...n,
    note: noteNameFromMidi(n.midi),
    velocity: 0.92
  }));

  return cleaned;
}

async function startRecording() {
  try {
    stopPlayback();
    ensureAudioContext();

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    await Tone.start();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.82;

    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(analyser);

    rawFrames = [];
    riffNotes = [];
    renderNotes([]);

    recordBtn.disabled = true;
    stopBtn.disabled = false;
    playBtn.disabled = true;
    loopBtn.disabled = true;
    midiBtn.disabled = true;
    wavBtn.disabled = true;
    jsonBtn.disabled = true;

    isRecording = true;
    isLooping = false;
    loopBtn.textContent = "🔁 Loop Off";

    const buffer = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();

    captureInterval = setInterval(() => {
      if (!isRecording || !analyser) return;

      analyser.getFloatTimeDomainData(buffer);
      liveWave = new Float32Array(buffer);

      const freq = autoCorrelate(buffer, audioContext.sampleRate);
      const time = (performance.now() - startedAt) / 1000;
      const amp = averageAbs(buffer);

      rawFrames.push({
        time,
        freq,
        amp
      });
    }, 55);

    setStatus("Recording… hum away.");
    setMeta("Tap Stop when the riff is done.");
  } catch (err) {
    console.error(err);
    setStatus("Mic access failed. Please allow microphone access.");
    setMeta("Then try again.");
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
  playBtn.disabled = !hasNotes;
  loopBtn.disabled = !hasNotes;
  midiBtn.disabled = !hasNotes;
  wavBtn.disabled = !hasNotes;
  jsonBtn.disabled = !hasNotes;

  if (hasNotes) {
    setStatus("Riff captured. Give it a spin.");
  } else {
    setStatus("No clear riff detected. Try a cleaner hum.");
    setMeta("A short pause between notes helps.");
  }
}

function disposeBassChain() {
  if (bassChain) {
    try {
      bassChain.synth.dispose();
      bassChain.filter.dispose();
      bassChain.comp.dispose();
      bassChain.gain.dispose();
    } catch (_) {}
    bassChain = null;
  }
}

function makeBassChain() {
  disposeBassChain();

  const filter = new Tone.Filter(1600, "lowpass").toDestination();
  const comp = new Tone.Compressor({
    threshold: -20,
    ratio: 3,
    attack: 0.01,
    release: 0.2
  }).connect(filter);
  const gain = new Tone.Gain(0.9).connect(comp);

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

  bassChain = { synth, filter, comp, gain };
  return bassChain;
}

async function playRiff(loop = false) {
  if (!riffNotes.length) return;

  await Tone.start();
  stopPlayback();

  const chain = makeBassChain();
  const total = Math.max(...riffNotes.map(n => n.start + n.duration)) + 0.15;

  riffNotes.forEach(n => {
    Tone.Transport.schedule((time) => {
      chain.synth.triggerAttackRelease(n.note, n.duration, time, n.velocity);
    }, n.start);
  });

  Tone.Transport.start();
  setStatus(loop ? "Looping…" : "Playing…");

  if (loop) {
    currentLoopTimeout = setTimeout(() => {
      if (isLooping) playRiff(true);
    }, total * 1000);
  } else {
    currentLoopTimeout = setTimeout(() => {
      setStatus("Playback finished.");
    }, total * 1000);
  }
}

function stopPlayback() {
  clearTimeout(currentLoopTimeout);
  Tone.Transport.stop();
  Tone.Transport.cancel();
}

function exportJSON() {
  if (!riffNotes.length) return;

  const payload = {
    createdAt: new Date().toISOString(),
    settings: {
      sound: soundSelect.value,
      correctPitch: snapToggle.checked,
      tightenRhythm: tightToggle.checked,
      octaveShift: Number(octaveShift.value)
    },
    notes: riffNotes
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json"
  });

  downloadBlob(blob, "hum-to-bass-riff.json");
}

function writeVarLen(value) {
  let buffer = value & 0x7F;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= ((value & 0x7F) | 0x80);
  }
  while (true) {
    bytes.push(buffer & 0xFF);
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

  track.push(0x00, 0xFF, 0x51, 0x03, (tempo >> 16) & 0xFF, (tempo >> 8) & 0xFF, tempo & 0xFF);

  let previousTick = 0;

  riffNotes.forEach(note => {
    const startTick = Math.round(note.start * 2 * tpqn);
    const durTick = Math.max(60, Math.round(note.duration * 2 * tpqn));

    track.push(...writeVarLen(startTick - previousTick), 0x90, note.midi, 100);
    track.push(...writeVarLen(durTick), 0x80, note.midi, 0x00);

    previousTick = startTick + durTick;
  });

  track.push(0x00, 0xFF, 0x2F, 0x00);

  const header = [
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (tpqn >> 8) & 0xFF, tpqn & 0xFF
  ];

  const trackHeader = [
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >> 24) & 0xFF,
    (track.length >> 16) & 0xFF,
    (track.length >> 8) & 0xFF,
    track.length & 0xFF
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
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
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

function refreshFromSettings() {
  if (!rawFrames.length || isRecording) return;
  riffNotes = buildRiff(rawFrames);
  renderNotes(riffNotes);

  const hasNotes = riffNotes.length > 0;
  playBtn.disabled = !hasNotes;
  loopBtn.disabled = !hasNotes;
  midiBtn.disabled = !hasNotes;
  wavBtn.disabled = !hasNotes;
  jsonBtn.disabled = !hasNotes;

  if (hasNotes) {
    setStatus("Riff updated.");
  }
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

[snapToggle, tightToggle, octaveShift].forEach(el => {
  el.addEventListener("change", refreshFromSettings);
});

soundSelect.addEventListener("change", () => {
  if (!riffNotes.length) return;
  setStatus("Sound changed.");
});

window.addEventListener("beforeunload", () => {
  stopPlayback();
  stopLiveAudio();
  if (drawHandle) cancelAnimationFrame(drawHandle);
  disposeBassChain();
});

drawWave();
