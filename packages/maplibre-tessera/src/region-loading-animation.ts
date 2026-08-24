/**
 * Region-wide loading animation — WebGL shader → MapLibre ImageSource.
 *
 * Renders effects on an offscreen WebGL canvas, composites HUD text with
 * Canvas2D, then pushes to a MapLibre ImageSource at throttled intervals.
 * Because the image is geo-referenced, it rotates and pitches with the map.
 *
 * Effects (all GPU via fragment shader):
 *   - Polygon-clipped dark overlay
 *   - Tile grid with per-cell glow as chunks load
 *   - Data-flow dots streaming along grid lines
 *   - Dual scan lines + diagonal accent
 *   - Progress ring with spinning accents
 *   - Polygon edge glow + corner brackets
 *   - CRT scanline + noise grain
 *
 * HUD text (Canvas2D, composited on top):
 *   - Percentage, status label, tile count at polygon centroid
 */

import type { Map as MaplibreMap } from 'maplibre-gl';

export interface RegionAnimationOpts {
  map: MaplibreMap;
  polygon: [number, number][];
  bbox: [number, number, number, number];
  chunks: { ci: number; cj: number }[];
  ciMin: number; ciMax: number; cjMin: number; cjMax: number;
  chunkCorners: (ci: number, cj: number) => [number, number][];
}

const SOURCE_ID = 'zarr-region-anim-src';
const LAYER_ID = 'zarr-region-anim-lyr';
const CANVAS_W = 1024;
const PUSH_INTERVAL = 60; // ms between MapLibre image updates

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
varying vec2 v_uv;

uniform float u_time;
uniform float u_progress;
uniform vec2  u_gridSize;
uniform vec2  u_centroid;
uniform float u_aspect;
uniform sampler2D u_tiles;
uniform sampler2D u_mask;

const vec3  C   = vec3(0.0, 0.898, 1.0);
const vec3  MAG = vec3(1.0, 0.0, 0.5);
const float PI  = 3.14159265;
const float TAU = 6.28318530;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec2 uv = v_uv;

  // Polygon mask
  float m = texture2D(u_mask, uv).r;
  if (m < 0.5) discard;

  // Dark base
  vec3 col = vec3(0.0, 0.012, 0.025);
  float alpha = 0.95;

  // --- Grid ---
  vec2 cell = uv * u_gridSize;
  vec2 cf   = fract(cell);
  vec2 ci   = floor(cell);
  float lw  = 0.018;
  float gx  = smoothstep(0.0, lw, cf.x) * smoothstep(0.0, lw, 1.0 - cf.x);
  float gy  = smoothstep(0.0, lw, cf.y) * smoothstep(0.0, lw, 1.0 - cf.y);
  float grid = 1.0 - gx * gy;

  // Data-flow dots along grid lines
  float flowX = smoothstep(0.85, 1.0, fract(uv.x * u_gridSize.x * 3.0 - u_time * 2.5));
  float flowY = smoothstep(0.85, 1.0, fract(uv.y * u_gridSize.y * 3.0 - u_time * 1.8));
  float onLineH = 1.0 - smoothstep(0.0, lw * 1.5, cf.y) * smoothstep(0.0, lw * 1.5, 1.0 - cf.y);
  float onLineV = 1.0 - smoothstep(0.0, lw * 1.5, cf.x) * smoothstep(0.0, lw * 1.5, 1.0 - cf.x);
  float dataFlow = onLineH * flowX + onLineV * flowY;

  // --- Tile state ---
  vec2 tuv    = (ci + 0.5) / u_gridSize;
  vec4 ts     = texture2D(u_tiles, tuv);
  float loaded = step(0.5, ts.r);
  float age    = ts.g;

  // Flash: intense white-cyan burst that fades over ~1s
  float flash   = loaded * max(0.0, 1.0 - age * 2.5);
  float flash2  = flash * flash;  // sharper falloff, punchier hit
  // Steady breathing glow on loaded tiles
  float breathe = loaded * (0.18 + 0.09 * sin(u_time * 2.5 + ci.x * 0.7 + ci.y * 0.5));

  col += C * breathe;
  col += C * flash2 * 1.2;                    // bright cyan burst
  col += vec3(1.0) * flash2 * 0.4;            // white-hot core
  col += MAG * flash * 0.25;                   // magenta fringe
  col += C * loaded * 0.10;                    // constant loaded fill
  col += C * grid * (0.08 + loaded * 0.45);    // bright grid on loaded
  col += C * loaded * dataFlow * 0.5;          // data flow dots

  // Unloaded: dim but visible pulse
  float unl = 1.0 - loaded;
  col += C * unl * 0.04 * (0.5 + 0.5 * sin(u_time * 1.5 + ci.x + ci.y * 0.7));
  col += C * grid * unl * 0.04;

  // --- Scan lines — bright primary, subtle secondary ---
  float s1 = fract(u_time * 0.14);
  float s1d = abs(uv.y - s1);
  col += C * smoothstep(0.05, 0.0, s1d) * 0.4;
  col += vec3(1.0) * smoothstep(0.005, 0.0, s1d) * 0.15;  // white-hot core
  float s2 = fract(u_time * 0.09 + 0.5);
  col += C * smoothstep(0.025, 0.0, abs(uv.y - s2)) * 0.12;
  float dg = fract(u_time * 0.065 + 0.33);
  col += C * smoothstep(0.025, 0.0, abs((uv.x + uv.y) * 0.5 - dg)) * 0.10;

  // --- Progress ring ---
  vec2 d    = (uv - u_centroid) * vec2(u_aspect, 1.0);
  float dist = length(d);
  float rR  = 0.08;
  float rW  = 0.004;

  col += C * smoothstep(rW * 2.0, 0.0, abs(dist - rR)) * 0.06;

  float ang = atan(-d.y, d.x);
  float nA  = mod(ang + PI * 0.5, TAU) / TAU;
  col += C * step(nA, u_progress) * smoothstep(rW, 0.0, abs(dist - rR)) * 0.9;

  if (u_progress > 0.001 && u_progress < 0.999) {
    float tipAng = -PI * 0.5 + u_progress * TAU;
    vec2 tipD = vec2(cos(tipAng), -sin(tipAng)) * rR;
    col += vec3(1.0) * smoothstep(0.012, 0.0, length(d - tipD)) * 0.7;
  }

  float oR  = rR * 1.3;
  float onO = smoothstep(0.003, 0.0, abs(dist - oR));
  float spA = mod(ang + u_time * 1.8, TAU) / TAU;
  col += C * onO * step(0.5, fract(spA * 12.0)) * 0.12;

  float iR  = rR * 0.7;
  float onI = smoothstep(0.002, 0.0, abs(dist - iR));
  float spI = mod(ang - u_time * 1.2, TAU) / TAU;
  col += C * onI * step(0.5, fract(spI * 8.0)) * 0.06;

  // --- Edge glow (from mask gradient) ---
  float px = 1.0 / 256.0;
  float ex = texture2D(u_mask, uv + vec2(px*2.0,0.0)).r - texture2D(u_mask, uv - vec2(px*2.0,0.0)).r;
  float ey = texture2D(u_mask, uv + vec2(0.0,px*2.0)).r - texture2D(u_mask, uv - vec2(0.0,px*2.0)).r;
  col += C * length(vec2(ex,ey)) * (0.45 + 0.2 * sin(u_time * 2.5)) * 2.5;

  // --- Corner brackets ---
  float bL = 0.065, bT = 0.005;
  float tl = max(step(uv.x, bL) * step(uv.y, bT), step(uv.y, bL) * step(uv.x, bT));
  float tr = max(step(1.0-bL, uv.x) * step(uv.y, bT), step(1.0-bT, uv.x) * step(uv.y, bL));
  float bl = max(step(uv.x, bL) * step(1.0-bT, uv.y), step(1.0-bL, uv.y) * step(uv.x, bT));
  float br = max(step(1.0-bL, uv.x) * step(1.0-bT, uv.y), step(1.0-bT, uv.x) * step(1.0-bL, uv.y));
  col += C * max(max(tl,tr), max(bl,br)) * (0.55 + 0.35 * sin(u_time * 2.2));

  // --- CRT + grain ---
  col *= 1.0 - 0.04 * step(0.5, fract(gl_FragCoord.y * 0.5));
  col += (hash(uv * 500.0 + u_time * 7.0) - 0.5) * 0.02;

  gl_FragColor = vec4(col, alpha * m);
}
`;

// ---------------------------------------------------------------------------
// GL helpers
// ---------------------------------------------------------------------------

function compileShader(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('[RegionAnim] shader:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function linkProgram(gl: WebGLRenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram | null {
  const p = gl.createProgram();
  if (!p) return null;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[RegionAnim] link:', gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Animation class
// ---------------------------------------------------------------------------

export class RegionLoadingAnimation {
  private map: MaplibreMap;
  private destroyed = false;
  private loaded = 0;
  private total: number;
  private startTime = performance.now();

  // Grid
  private gridRows: number;
  private gridCols: number;
  private ciMin: number;
  private cjMin: number;
  private chunkSet: Set<string>;
  private loadedSet = new Set<string>();
  private tileLoadTime = new Map<string, number>();

  // Canvas / GL
  private glCanvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vbuf: WebGLBuffer | null = null;
  private tileTex: WebGLTexture | null = null;
  private maskTex: WebGLTexture | null = null;
  private tileData: Uint8Array;
  private loc: Record<string, WebGLUniformLocation | null> = {};

  // 2D compositing canvas (HUD text drawn here)
  private outCanvas: HTMLCanvasElement;
  private outCtx: CanvasRenderingContext2D;
  private cw: number;
  private ch: number;

  // MapLibre ImageSource corners
  private corners: [[number, number], [number, number], [number, number], [number, number]];

  // Centroid (UV + canvas pixel)
  private centroidUV: [number, number];
  private hudScaleX: number;

  // Aspect correction for shader
  private aspectRatio: number;

  // Animation state
  private frameId: number | null = null;
  private lastPush = 0;
  private pendingUpdate = false;
  private labels = ['ACQUIRING', 'EMBEDDING', 'SCANNING', 'ANALYSING'];

  /** Embedding dimensions being fetched, shown beside the tile count. */
  private depth = 0;

  /** Name the width this load is fetching at. */
  setDepth(depth: number): void {
    this.depth = depth;
  }

  constructor(opts: RegionAnimationOpts) {
    this.map = opts.map;
    this.total = opts.chunks.length;
    this.ciMin = opts.ciMin;
    this.cjMin = opts.cjMin;
    this.gridRows = opts.ciMax - opts.ciMin + 1;
    this.gridCols = opts.cjMax - opts.cjMin + 1;
    this.chunkSet = new Set(opts.chunks.map(c => `${c.ci}_${c.cj}`));
    this.tileData = new Uint8Array(this.gridCols * this.gridRows * 4);

    const [west, south, east, north] = opts.bbox;

    // Canvas aspect from bbox
    const aspect = (east - west) / (north - south);
    this.cw = CANVAS_W;
    this.ch = Math.round(CANVAS_W / Math.max(0.1, aspect));
    this.ch = Math.max(100, Math.min(2048, this.ch));

    // Corners for MapLibre ImageSource (TL, TR, BR, BL)
    this.corners = [
      [west, north], [east, north],
      [east, south], [west, south],
    ];

    // Mercator HUD correction
    const centerLat = (south + north) / 2;
    this.hudScaleX = 1 / Math.cos(centerLat * Math.PI / 180);
    this.aspectRatio = (east - west)
      / ((north - south) * Math.cos(centerLat * Math.PI / 180));

    // Polygon centroid
    const pp = opts.polygon;
    let aSum = 0, cxS = 0, cyS = 0;
    for (let i = 0, j = pp.length - 1; i < pp.length; j = i++) {
      const cr = pp[j][0] * pp[i][1] - pp[i][0] * pp[j][1];
      aSum += cr; cxS += (pp[j][0] + pp[i][0]) * cr; cyS += (pp[j][1] + pp[i][1]) * cr;
    }
    if (Math.abs(aSum) > 1e-10) {
      this.centroidUV = [cxS / (3 * aSum), cyS / (3 * aSum)];
    } else {
      this.centroidUV = [(west + east) / 2, (south + north) / 2];
    }
    // Convert to UV (0-1 in bbox)
    this.centroidUV = [
      (this.centroidUV[0] - west) / (east - west),
      (north - this.centroidUV[1]) / (north - south),
    ];

    // --- Offscreen WebGL canvas ---
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.width = this.cw;
    this.glCanvas.height = this.ch;
    this.gl = this.glCanvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false,
    });
    if (this.gl) this.initGL(this.gl, opts.polygon, west, south, east, north);

    // --- 2D compositing canvas ---
    this.outCanvas = document.createElement('canvas');
    this.outCanvas.width = this.cw;
    this.outCanvas.height = this.ch;
    this.outCtx = this.outCanvas.getContext('2d')!;

    // Add to map
    this.addToMap();
    this.animate(performance.now());
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  updateProgress(loaded: number, total: number): void {
    this.loaded = loaded;
    this.total = total;
  }

  markTileLoaded(ci: number, cj: number): void {
    const key = `${ci}_${cj}`;
    if (!this.loadedSet.has(key)) {
      this.loadedSet.add(key);
      this.tileLoadTime.set(key, performance.now());
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frameId != null) cancelAnimationFrame(this.frameId);
    const gl = this.gl;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.vbuf) gl.deleteBuffer(this.vbuf);
      if (this.tileTex) gl.deleteTexture(this.tileTex);
      if (this.maskTex) gl.deleteTexture(this.maskTex);
    }
    try {
      if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
      if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
    } catch { /* map may be gone */ }
  }

  // -----------------------------------------------------------------------
  // Private: WebGL init
  // -----------------------------------------------------------------------

  private initGL(
    gl: WebGLRenderingContext,
    polygon: [number, number][],
    west: number, south: number, east: number, north: number,
  ): void {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    this.program = linkProgram(gl, vs, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!this.program) return;

    for (const n of ['u_time', 'u_progress', 'u_gridSize', 'u_centroid',
      'u_aspect', 'u_tiles', 'u_mask']) {
      this.loc[n] = gl.getUniformLocation(this.program, n);
    }

    // Fullscreen quad
    this.vbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1,
    ]), gl.STATIC_DRAW);

    // Tile state texture
    this.tileTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.gridCols, this.gridRows,
      0, gl.RGBA, gl.UNSIGNED_BYTE, this.tileData);

    // Polygon mask texture (256x256)
    const S = 256;
    const mc = document.createElement('canvas');
    mc.width = S; mc.height = S;
    const mctx = mc.getContext('2d')!;
    mctx.fillStyle = '#000';
    mctx.fillRect(0, 0, S, S);
    mctx.fillStyle = '#fff';
    mctx.beginPath();
    for (let i = 0; i < polygon.length; i++) {
      const u = ((polygon[i][0] - west) / (east - west)) * S;
      const v = ((north - polygon[i][1]) / (north - south)) * S;
      if (i === 0) mctx.moveTo(u, v); else mctx.lineTo(u, v);
    }
    mctx.closePath();
    mctx.fill();

    this.maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mc);

    gl.viewport(0, 0, this.cw, this.ch);
    gl.clearColor(0, 0, 0, 0);
  }

  // -----------------------------------------------------------------------
  // Private: render one frame
  // -----------------------------------------------------------------------

  private renderFrame(): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    // --- WebGL pass ---
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    const t = (performance.now() - this.startTime) / 1000;
    const prog = this.total > 0 ? this.loaded / this.total : 0;

    gl.uniform1f(this.loc['u_time']!, t);
    gl.uniform1f(this.loc['u_progress']!, prog);
    gl.uniform2f(this.loc['u_gridSize']!, this.gridCols, this.gridRows);
    gl.uniform2f(this.loc['u_centroid']!, this.centroidUV[0], this.centroidUV[1]);
    gl.uniform1f(this.loc['u_aspect']!, this.aspectRatio);

    this.refreshTileData();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.gridCols, this.gridRows,
      0, gl.RGBA, gl.UNSIGNED_BYTE, this.tileData);
    gl.uniform1i(this.loc['u_tiles']!, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.loc['u_mask']!, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf);
    const posLoc = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // --- 2D compositing: copy WebGL + draw HUD text ---
    const ctx = this.outCtx;
    ctx.clearRect(0, 0, this.cw, this.ch);
    ctx.drawImage(this.glCanvas, 0, 0);

    // HUD text at centroid (with Mercator correction)
    const cx = this.centroidUV[0] * this.cw;
    const cy = this.centroidUV[1] * this.ch;
    const progress = prog;
    const pct = Math.round(progress * 100);
    const elapsed = (performance.now() - this.startTime) / 1000;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(this.hudScaleX, 1);

    // Background panel — large, high-contrast
    const fontSize = Math.max(20, Math.round(Math.min(this.cw, this.ch) * 0.10));
    const pw = fontSize * 2.8, ph = fontSize * 1.8;
    ctx.fillStyle = 'rgba(0, 2, 8, 0.92)';
    ctx.strokeStyle = `rgba(0, 229, 255, ${0.35 + 0.15 * Math.sin(elapsed * 2)})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 229, 255, 0.3)';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.roundRect(-pw, -ph, pw * 2, ph * 2, 8);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Percentage — big and glowing
    ctx.font = `bold ${fontSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 229, 255, 0.8)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = `rgba(0, 229, 255, ${0.9 + 0.1 * Math.sin(elapsed * 4)})`;
    ctx.fillText(`${pct}%`, 0, -fontSize * 0.4);
    ctx.shadowBlur = 0;

    // Status label
    const subSize = Math.max(10, Math.round(fontSize * 0.34));
    ctx.font = `bold ${subSize}px monospace`;
    ctx.fillStyle = 'rgba(0, 229, 255, 0.6)';
    ctx.letterSpacing = '3px';
    const labelIdx = Math.floor(elapsed / 2) % this.labels.length;
    ctx.fillText(this.labels[labelIdx], 0, fontSize * 0.35);

    // Tile count
    const countSize = Math.max(9, Math.round(fontSize * 0.3));
    ctx.font = `${countSize}px monospace`;
    ctx.fillStyle = 'rgba(0, 229, 255, 0.4)';
    const at = this.depth ? ` \u00b7 ${this.depth}D` : '';
    ctx.fillText(`${this.loaded}/${this.total} TILES${at}`, 0, fontSize * 0.35 + countSize * 1.8);

    ctx.restore();
  }

  private refreshTileData(): void {
    const now = performance.now();
    for (let r = 0; r < this.gridRows; r++) {
      for (let c = 0; c < this.gridCols; c++) {
        const key = `${r + this.ciMin}_${c + this.cjMin}`;
        const idx = (r * this.gridCols + c) * 4;
        if (this.loadedSet.has(key)) {
          this.tileData[idx] = 255;
          const age = Math.min(1, (now - (this.tileLoadTime.get(key) ?? now)) / 3000);
          this.tileData[idx + 1] = Math.round(age * 255);
        } else {
          this.tileData[idx] = 0;
          this.tileData[idx + 1] = 0;
        }
        this.tileData[idx + 3] = 255;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: MapLibre ImageSource
  // -----------------------------------------------------------------------

  private addToMap(): void {
    this.renderFrame();
    const dataUrl = this.outCanvas.toDataURL('image/png');

    if (this.map.getLayer(LAYER_ID)) this.map.removeLayer(LAYER_ID);
    if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);

    this.map.addSource(SOURCE_ID, {
      type: 'image', url: dataUrl, coordinates: this.corners,
    });
    this.map.addLayer({
      id: LAYER_ID, type: 'raster', source: SOURCE_ID,
      paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
    });
  }

  private animate = (t: number): void => {
    if (this.destroyed) return;
    this.renderFrame();

    if (t - this.lastPush >= PUSH_INTERVAL && !this.pendingUpdate) {
      this.pendingUpdate = true;
      this.lastPush = t;
      const url = this.outCanvas.toDataURL('image/png');
      const src = this.map.getSource(SOURCE_ID) as
        { updateImage?: (o: { url: string; coordinates: [number, number][] }) => unknown } | undefined;
      try {
        const result = src?.updateImage?.({ url, coordinates: this.corners });
        if (result && typeof (result as any).then === 'function') {
          (result as any).then(() => { this.pendingUpdate = false; }, () => { this.pendingUpdate = false; });
        } else {
          this.pendingUpdate = false;
        }
      } catch { this.pendingUpdate = false; }
    }

    this.frameId = requestAnimationFrame(this.animate);
  };
}
