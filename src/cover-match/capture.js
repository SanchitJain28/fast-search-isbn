export const CAPTURE_INSET = 0.08;
const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 48;
const MOTION_PIXEL_DELTA = 24;
const PRESENCE_PIXEL_DELTA = 16;
const STABLE_DELTA = 0.05;
const OCCUPIED_DELTA = 0.045;
const EMPTY_DELTA = 0.025;
const SETTLE_MS = 500;
const CLEAR_MS = 300;

function changedFraction(frame, reference, pixelDelta) {
  let changed = 0;
  for (let i = 0; i < frame.length; i++) if (Math.abs(frame[i] - reference[i]) >= pixelDelta) changed++;
  return changed / frame.length;
}

export function createCaptureDetector() {
  let background;
  let previous;
  let lastTime;
  let stableSince;
  let clearSince;
  let waitingForClear = false;
  return {
    hold() { waitingForClear = true; clearSince = undefined; stableSince = undefined; },
    sample(frame, time, autoAllowed) {
      const settled = previous && time - lastTime <= 350 && changedFraction(frame, previous, MOTION_PIXEL_DELTA) <= STABLE_DELTA;
      previous = frame;
      lastTime = time;
      if (waitingForClear) {
        if (background && settled && changedFraction(frame, background, PRESENCE_PIXEL_DELTA) <= EMPTY_DELTA) {
          clearSince ??= time;
          if (time - clearSince >= CLEAR_MS) {
            waitingForClear = false;
            clearSince = undefined;
            background = frame;
            return { state: 'ready', capture: false };
          }
        } else clearSince = undefined;
        return { state: background ? 'clear' : 'reset', capture: false };
      }

      const occupied = background && changedFraction(frame, background, PRESENCE_PIXEL_DELTA) >= OCCUPIED_DELTA;
      if (settled && (!background || (occupied && autoAllowed))) stableSince ??= time;
      else stableSince = undefined;
      if (stableSince !== undefined && time - stableSince >= SETTLE_MS) {
        stableSince = undefined;
        if (!background) background = frame;
        else {
          waitingForClear = true;
          return { state: 'clear', capture: true };
        }
      }
      return { state: !background ? 'calibrating' : occupied && autoAllowed ? 'detected' : 'ready', capture: false };
    },
  };
}

export function captureCrop(width, height) {
  const x = Math.round(width * CAPTURE_INSET), y = Math.round(height * CAPTURE_INSET);
  return { x, y, width: width - 2 * x, height: height - 2 * y };
}

export function makeFrameSampler(canvas) {
  canvas.width = SAMPLE_WIDTH;
  canvas.height = SAMPLE_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return video => {
    if (!context || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    const { x, y, width, height } = captureCrop(video.videoWidth, video.videoHeight);
    context.drawImage(video, x, y, width, height, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const { data } = context.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
    const gray = new Uint8Array(SAMPLE_WIDTH * SAMPLE_HEIGHT);
    for (let i = 0; i < gray.length; i++) gray[i] = (77 * data[4 * i] + 150 * data[4 * i + 1] + 29 * data[4 * i + 2]) >> 8;
    return gray;
  };
}

export function takeCoverPhoto(video, canvas) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) throw new Error('Wait for the live camera preview before capturing.');
  const { x, y, width, height } = captureCrop(video.videoWidth, video.videoHeight);
  const scale = Math.min(1, 2000 / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not prepare the capture.');
  context.drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob || blob.size > 5 * 1024 * 1024) reject(new Error('Could not prepare a photo within the 5 MiB limit.'));
    else resolve(blob);
  }, 'image/jpeg', 0.9));
}

export function matchesPedal(event, setting) {
  if (!setting || event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (isEditing(event.target)) return false;
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  if (['enter', 'space'].includes(key) && event.target?.closest?.('button, a[href], input, [role="button"], [role="combobox"]')) return false;
  return key === setting.trim().toLowerCase();
}

export function isEditing(target) {
  const field = target?.closest?.('input, textarea, [role="textbox"]');
  return Boolean(target?.isContentEditable || (field && !['button', 'checkbox', 'radio', 'range', 'reset', 'submit'].includes(field.type)));
}
