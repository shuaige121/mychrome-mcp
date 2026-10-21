/**
 * Coordinate math: CSS viewport pixels -> Quartz global screen POINTS.
 *
 * Units, because this is where these things usually go wrong:
 *  - AppleScript `bounds of window 1` is in screen POINTS, top-left origin,
 *    global across all displays. That is exactly the space CGEvent posts into.
 *  - getBoundingClientRect() is in CSS pixels relative to the viewport.
 *  - On a Retina display 1 point == 2 physical pixels. CGEvent wants POINTS,
 *    so devicePixelRatio must NOT appear in this conversion. It is reported
 *    only for diagnostics.
 *  - Browser page zoom does show up: window.outerWidth/innerWidth are reported
 *    in CSS pixels, so (AppleScript width / outerWidth) recovers the zoom
 *    factor and converts CSS px to points in one step.
 */

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

/**
 * @param {{left:number,top:number,width:number,height:number}|null} bounds AppleScript window bounds
 * @param {{innerWidth:number,innerHeight:number,outerWidth:number,outerHeight:number,screenX?:number,screenY?:number,dpr?:number}} view
 * @returns {{originX:number,originY:number,scale:number,toolbarHeight:number,sideInset:number,source:string}}
 */
export function viewportOrigin(bounds, view) {
  const outerW = Number(view.outerWidth) || 0;
  const outerH = Number(view.outerHeight) || 0;
  const innerW = Number(view.innerWidth) || 0;
  const innerH = Number(view.innerHeight) || 0;

  let scale = 1;
  let source = 'applescript-bounds';

  if (bounds && bounds.width > 0 && outerW > 0) {
    const s = bounds.width / outerW;
    if (s >= MIN_SCALE && s <= MAX_SCALE) scale = s;
  }

  // Left/right window chrome. Zero on macOS Chrome, non-zero on some setups.
  const sideInset = Math.max(0, (outerW - innerW) / 2);
  // Tab strip + omnibox + bookmarks bar, in CSS px.
  const toolbarHeight = Math.max(0, outerH - innerH - sideInset);

  let originX;
  let originY;

  if (bounds && Number.isFinite(bounds.left) && Number.isFinite(bounds.top)) {
    originX = bounds.left + sideInset * scale;
    originY = bounds.top + toolbarHeight * scale;
  } else if (Number.isFinite(view.screenX) && Number.isFinite(view.screenY)) {
    // Fallback: Chrome reports the window's outer top-left in screen points.
    source = 'window.screenXY';
    originX = view.screenX + sideInset * scale;
    originY = view.screenY + toolbarHeight * scale;
  } else {
    throw new Error('no_window_bounds');
  }

  return { originX, originY, scale, toolbarHeight, sideInset, source };
}

/**
 * Uniformly random point inside the central 60% of a rect (CSS px, viewport-relative).
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {() => number} rng 0..1
 */
export function pointInCentralArea(rect, rng = Math.random) {
  const insetX = rect.width * 0.2;
  const insetY = rect.height * 0.2;
  return {
    x: rect.x + insetX + rng() * (rect.width - 2 * insetX),
    y: rect.y + insetY + rng() * (rect.height - 2 * insetY)
  };
}

/** Convert a viewport CSS-px point to a global screen point. */
export function toScreen(point, origin) {
  return {
    x: origin.originX + point.x * origin.scale,
    y: origin.originY + point.y * origin.scale
  };
}

/** One-shot: rect + window info -> screen point to click. */
export function rectToScreenPoint(rect, bounds, view, rng = Math.random) {
  const origin = viewportOrigin(bounds, view);
  const local = pointInCentralArea(rect, rng);
  const screen = toScreen(local, origin);
  return {
    screen: { x: Math.round(screen.x * 100) / 100, y: Math.round(screen.y * 100) / 100 },
    local,
    origin
  };
}

/** Is a screen point inside the Chrome window's viewport area? */
export function pointInViewport(pt, bounds, view) {
  if (!bounds) return false;
  const o = viewportOrigin(bounds, view);
  return pt.x >= o.originX &&
         pt.x <= o.originX + view.innerWidth * o.scale &&
         pt.y >= o.originY &&
         pt.y <= o.originY + view.innerHeight * o.scale;
}

/** Intersection of two {x,y,width,height} rects, or null when they do not overlap. */
export function intersectRect(a, b) {
  if (!a || !b) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r - x <= 0 || btm - y <= 0) return null;
  return { x, y, width: r - x, height: btm - y };
}

/** A viewport CSS-px rect {x,y,width,height} as a screen-point rect {x,y,w,h} (the input helper's shape). */
export function rectToScreenRect(rect, origin) {
  const p = toScreen({ x: rect.x, y: rect.y }, origin);
  const round = (v) => Math.round(v * 100) / 100;
  return { x: round(p.x), y: round(p.y), w: round(rect.width * origin.scale), h: round(rect.height * origin.scale) };
}

/** A square of `size` CSS px centred on a viewport point, as a screen-point rect. */
export function squareToScreenRect(point, size, origin) {
  return rectToScreenRect({ x: point.x - size / 2, y: point.y - size / 2, width: size, height: size }, origin);
}
