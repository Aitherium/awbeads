/**
 * Street contract (owner, 2026-10-17): the sky follows the real clock, every place is
 * reachable, and the street costs nothing when nobody is looking -- a street created
 * paused schedules no frame, a hidden tab stops the loop, a visible tab never resumes a
 * street the HOST paused.
 */
import { JSDOM } from 'jsdom';
import { skyAt, sunTimes, crowdAt } from '../src/scene/sky';
import { createStreet, streetLayout, streetLength, type StreetPlace } from '../src/scene/street';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ok   ${label}${detail ? ` -- ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}
const at = (h: number, m = 0) => new Date(2026, 9, 17, h, m, 0);

console.log('sky follows the clock');
const noon = skyAt(at(12));
check('noon is day', noon.phase === 'day', noon.phase);
check('noon sun is up', noon.body === 'sun' && noon.bodyY > 0.9, `${noon.body} y=${noon.bodyY.toFixed(2)}`);
check('noon streetlights off', !noon.lightsOn);
check('noon no stars', noon.starAlpha === 0);
const late = skyAt(at(22));
check('22:00 is night', late.phase === 'night', late.phase);
check('22:00 moon', late.body === 'moon');
check('22:00 streetlights on', late.lightsOn);
check('22:00 stars out', late.starAlpha > 0.9, late.starAlpha.toFixed(2));
check('22:00 night crowd beats noon', late.crowd > noon.crowd, `${late.crowd.toFixed(2)} > ${noon.crowd.toFixed(2)}`);
const dusk = skyAt(at(18, 30));
check('18:30 is dusk (fallback day)', dusk.phase === 'dusk', dusk.phase);
check('dusk is between night and day', dusk.daylight > 0.1 && dusk.daylight < 0.9, dusk.daylight.toFixed(2));
const dawn = skyAt(at(6, 30));
check('06:30 is dawn (fallback day)', dawn.phase === 'dawn', dawn.phase);
let monotone = true;
let prev = -1;
for (let m = 18 * 60; m <= 20 * 60; m += 5) {
  const d = skyAt(at(Math.floor(m / 60), m % 60)).daylight;
  if (prev >= 0 && d > prev + 1e-9) monotone = false;
  prev = d;
}
check('daylight only falls through the evening', monotone);
check('sky colours are hex', /^#[0-9a-f]{6}$/.test(dusk.top) && /^#[0-9a-f]{6}$/.test(dusk.horizon), `${dusk.top} ${dusk.horizon}`);

console.log('real sunrise/sunset from a location');
const sf = sunTimes(new Date(2026, 5, 21, 12), 37.77, -122.42);
const offsetH = -new Date(2026, 5, 21, 12).getTimezoneOffset() / 60;
// shift the expected Pacific answer into this machine's local zone
const pdt = -7;
const exRise = 5.8 + (offsetH - pdt);
const exSet = 20.6 + (offsetH - pdt);
const wrap = (x: number) => ((x % 24) + 24) % 24;
check('SF midsummer sunrise ~05:48 PDT', Math.abs(wrap(sf.sunrise - exRise + 12) - 12) < 0.25, sf.sunrise.toFixed(2));
check('SF midsummer sunset ~20:35 PDT', Math.abs(wrap(sf.sunset - exSet + 12) - 12) < 0.25, sf.sunset.toFixed(2));
const polar = sunTimes(new Date(2026, 11, 21, 12), 80, 0);
check('polar night never rises', polar.sunrise === 12 && polar.sunset === 12);
check('crowd stays in 0..1 all day', Array.from({ length: 48 }, (_, i) => crowdAt(i / 2)).every(c => c >= 0 && c <= 1));

console.log('every place is reachable');
const places: StreetPlace[] = [
  { id: 'shop', sign: 'Shop', kind: 'shop', npc: { id: 'aither', name: 'Aither' } },
  { id: 'relay', sign: 'Relay Bar', kind: 'bar' },
  { id: 'spaces', sign: 'Spaces', kind: 'spaces' },
  { id: 'lot', sign: 'Darkmatter', kind: 'lot', closed: true },
];
const lay = streetLayout(places);
const len = streetLength(places);
check('one door per place', lay.length === places.length);
check('doors left to right inside the street', lay.every((l, i) => l.x > 0 && l.x < len && (i === 0 || l.x > lay[i - 1].x)));
check('doors do not overlap', lay.every((l, i) => i === 0 || l.x - lay[i - 1].x >= l.width));

console.log('the loop costs nothing when nobody is looking');
const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', { pretendToBeVisual: true });
const { window } = dom;
const stage = window.document.querySelector('#stage') as HTMLElement;
stage.getBoundingClientRect = () => ({ width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720, x: 0, y: 0 }) as DOMRect;
let visibility: 'visible' | 'hidden' = 'visible';
Object.defineProperty(window.document, 'visibilityState', { get: () => visibility, configurable: true });
let scheduled = 0;
const pending = new Set<number>();
let nextId = 1;
const winAny = window as unknown as Record<string, unknown>;
winAny.requestAnimationFrame = (cb: FrameRequestCallback) => {
  const id = nextId++;
  if (cb.name === 'animateStreet') {
    scheduled += 1;
    pending.add(id);
  }
  return id;
};
winAny.cancelAnimationFrame = (id: number) => pending.delete(id);

const paused = createStreet(stage, { places, paused: true, now: () => at(22) });
check('created paused schedules no frame', scheduled === 0 && !paused.running(), `scheduled=${scheduled}`);
check('the sky is still answered while paused', paused.sky().phase === 'night');
paused.resume();
check('resume arms the loop', paused.running() && scheduled === 1);
visibility = 'hidden';
window.document.dispatchEvent(new window.Event('visibilitychange'));
check('a hidden tab stops the loop', !paused.running());
visibility = 'visible';
window.document.dispatchEvent(new window.Event('visibilitychange'));
check('a visible tab resumes a street the host did not pause', paused.running());
paused.pause();
visibility = 'hidden';
window.document.dispatchEvent(new window.Event('visibilitychange'));
visibility = 'visible';
window.document.dispatchEvent(new window.Event('visibilitychange'));
check('a visible tab never resumes a street the host paused', !paused.running());
paused.destroy();
check('destroy removes the canvas', stage.querySelector('canvas') === null);

const entered: string[] = [];
const talked: string[] = [];
const still = createStreet(stage, {
  places,
  reducedMotion: true,
  now: () => at(12),
  onEnter: p => entered.push(p.id),
  onTalk: (n, p) => talked.push(`${n.id}@${p.id}`),
});
check('reduced motion schedules no animation loop', !still.running());
still.walkTo('relay');
check('walkTo arrives at the door', still.near()?.id === 'relay');
still.walkTo('shop');
check('walking to the shop meets Aither', still.near()?.id === 'shop');
const key = (k: string) => stage.querySelector('canvas')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: k }));
key('e');
check('E at the shop talks to Aither', talked.includes('aither@shop'), talked.join(','));
still.walkTo('lot');
key('e');
check('a closed door does not open', !entered.includes('lot'));
still.walkTo('spaces');
key('e');
check('E at an open door enters', entered.includes('spaces'), entered.join(','));
still.destroy();

if (failures) {
  console.error(`street: ${failures} failure(s)`);
  process.exit(1);
}
console.log('street: all checks passed');
