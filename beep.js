// Sale-screen sound: a short bip on every button, a double bip on pay. WebAudio (no files, works offline).
// The AudioContext is created inside the first touch (browsers refuse sound before a user gesture).
let ac = null;
function tone(at, freq) {
  const t = ac.currentTime + at, o = ac.createOscillator(), g = ac.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  o.connect(g); g.connect(ac.destination);
  o.start(t); o.stop(t + 0.08);
}
export function beep(double = false) {
  try {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    tone(0, double ? 1500 : 1200);
    if (double) tone(0.11, 1500);
  } catch { /* no audio on this device: silent */ }
}
