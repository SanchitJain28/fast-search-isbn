import assert from 'node:assert/strict';
import test from 'node:test';
import { captureCrop, createCaptureDetector, isEditing, matchesPedal } from '../src/cover-match/capture.js';

const empty = new Uint8Array(100).fill(40);
const book = empty.slice(); book.fill(180, 12, 58);
const movingBook = empty.slice(); movingBook.fill(180, 45, 91);

function sample(detector, frame, times, auto = true) {
  return times.map(time => detector.sample(frame, time, auto));
}

test('camera waits for 500 ms of stability and rearms only after the book leaves', () => {
  const detector = createCaptureDetector();
  assert.equal(sample(detector, empty, [0, 100, 200, 300, 400, 500, 600]).at(-1).state, 'ready');
  assert.equal(detector.sample(movingBook, 700, true).capture, false);
  assert.equal(detector.sample(book, 800, true).capture, false);
  assert(sample(detector, book, [900, 1000, 1100, 1200, 1300]).every(result => !result.capture));
  assert.deepEqual(detector.sample(book, 1400, true), { state: 'clear', capture: true });
  assert(sample(detector, book, [1500, 1600, 1700, 1800, 1900, 2000]).every(result => result.state === 'clear' && !result.capture));
  assert.equal(sample(detector, empty, [2100, 2200, 2300, 2400]).at(-1).state, 'clear');
  assert.deepEqual(detector.sample(empty, 2500, true), { state: 'ready', capture: false });
  assert(sample(detector, book, [2600, 2700, 2800, 2900, 3000, 3100, 3200]).at(-1).capture);
});

test('manual capture holds the same book and hidden-frame gaps reset stability', () => {
  const detector = createCaptureDetector();
  sample(detector, empty, [0, 100, 200, 300, 400, 500, 600]);
  assert(sample(detector, book, [700, 800, 900, 1000, 1100, 1200, 1300], false).every(result => !result.capture));
  assert(sample(detector, book, [1400, 1500, 2100, 2200], true).every(result => !result.capture));
  detector.hold();
  assert.deepEqual(detector.sample(book, 2300, true), { state: 'clear', capture: false });
  const early = createCaptureDetector();
  early.hold();
  assert.equal(early.sample(book, 0, true).state, 'reset');
});

test('the detector recognizes a small low-contrast book after calibrating an empty desk', () => {
  const detector = createCaptureDetector();
  sample(detector, empty, [0, 100, 200, 300, 400, 500, 600]);
  const lowContrast = empty.slice();
  lowContrast.fill(58, 45, 52);
  assert.equal(detector.sample(lowContrast, 700, true).state, 'detected');
  assert(sample(detector, lowContrast, [800, 900, 1000, 1100, 1200]).at(-1).capture);
});

test('the pedal respects typing and normal keyboard controls', () => {
  const key = (value, options = {}) => ({ key: value, ...options });
  assert(matchesPedal(key('F8'), 'F8'));
  assert(matchesPedal(key(' '), 'Space'));
  assert(!matchesPedal(key('F8', { repeat: true }), 'F8'));
  assert(!matchesPedal(key('F8', { ctrlKey: true }), 'F8'));
  assert(!matchesPedal(key('F8', { target: { isContentEditable: true } }), 'F8'));
  assert(!isEditing({ closest: () => ({ type: 'checkbox' }) }));
  assert(!matchesPedal(key('Enter', { target: { closest: selector => selector.startsWith('button') } }), 'Enter'));
  assert.deepEqual(captureCrop(1000, 750), { x: 80, y: 60, width: 840, height: 630 });
});
