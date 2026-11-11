import { useCallback, useEffect, useRef, useState } from 'react';

function cameraError(error) {
  if (error.name === 'NotAllowedError') return 'Camera access was denied. Allow camera access for this site and try again.';
  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return 'This camera is unavailable. Connect it or select another camera.';
  if (error.name === 'NotReadableError') return 'The camera could not start. Close other apps using it and try again.';
  return 'The camera could not start. Try reconnecting it.';
}

export function useCoverCamera() {
  const video = useRef(null);
  const stream = useRef(null);
  const generation = useRef(0);
  const [devices, setDevices] = useState([]);
  const [status, setStatus] = useState('off');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const media = globalThis.navigator?.mediaDevices;
  const updateDevices = useCallback(async () => {
    try { setDevices((await media?.enumerateDevices() ?? []).filter(device => device.kind === 'videoinput')); }
    catch { /* The camera preview remains available even when device enumeration fails. */ }
  }, [media]);

  const release = useCallback(() => {
    generation.current++;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  useEffect(() => {
    void updateDevices();
    media?.addEventListener('devicechange', updateDevices);
    return () => { media?.removeEventListener('devicechange', updateDevices); release(); };
  }, [media, release, updateDevices]);

  async function start(deviceId = selected) {
    release();
    setError('');
    if (!media?.getUserMedia) {
      setStatus('off');
      setError('Camera access requires localhost or a trusted HTTPS address. Typed search is available below.');
      return;
    }
    setStatus('starting');
    const attempt = generation.current;
    const deadline = setTimeout(() => {
      if (generation.current !== attempt) return;
      release();
      setStatus('off');
      setError('The camera did not respond. Check camera permissions in your browser and try again.');
    }, 12000);
    try {
      const preferred = deviceId || devices.find(device => /kb[ -]?700|thustand|usb camera/i.test(device.label))?.deviceId;
      const input = await media.getUserMedia({ audio: false, video: {
        width: { ideal: 2560 }, height: { ideal: 1920 },
        ...(preferred ? { deviceId: { exact: preferred } } : { facingMode: { ideal: 'environment' } }),
      } });
      if (generation.current !== attempt || !video.current) { input.getTracks().forEach(track => track.stop()); return; }
      stream.current = input;
      video.current.srcObject = input;
      const track = input.getVideoTracks()[0];
      track?.addEventListener('ended', () => {
        if (generation.current !== attempt) return;
        release();
        setStatus('off');
        setError('The camera disconnected. Reconnect it and start it again.');
      }, { once: true });
      await video.current.play();
      if (generation.current !== attempt) return;
      setSelected(track?.getSettings().deviceId || preferred || '');
      setStatus('live');
      void updateDevices();
    } catch (failure) {
      if (generation.current !== attempt) return;
      release();
      setStatus('off');
      setError(cameraError(failure));
    } finally { clearTimeout(deadline); }
  }

  return {
    video, devices, status, error, selected, start,
    select(deviceId) { setSelected(deviceId); if (status === 'live') void start(deviceId); },
    stop() { release(); setStatus('off'); },
  };
}
