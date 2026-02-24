import proj4 from 'proj4';
import type { UtmBounds } from './types.js';

export class UtmProjection {
  readonly zone: number;
  readonly epsg: number;
  readonly isSouth: boolean;
  private proj: proj4.Converter;

  constructor(epsg: number) {
    this.epsg = epsg;
    this.isSouth = epsg >= 32700 && epsg <= 32760;
    this.zone = this.isSouth ? epsg - 32700 : epsg - 32600;

    const def = `+proj=utm +zone=${this.zone}${this.isSouth ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    this.proj = proj4('EPSG:4326', def);
  }

  /** WGS84 (lng, lat) -> UTM (easting, northing) */
  forward(lng: number, lat: number): [number, number] {
    const [e, n] = this.proj.forward([lng, lat]);
    return [e, n];
  }

  /** UTM (easting, northing) -> WGS84 (lng, lat) */
  inverse(easting: number, northing: number): [number, number] {
    const [lng, lat] = this.proj.inverse([easting, northing]);
    return [lng, lat];
  }

  /** Convert UTM bounds to [TL, TR, BR, BL] as [lng, lat] for MapLibre image source */
  chunkCornersToLngLat(b: UtmBounds): [[number, number], [number, number], [number, number], [number, number]] {
    const tl = this.inverse(b.minE, b.maxN);
    const tr = this.inverse(b.maxE, b.maxN);
    const br = this.inverse(b.maxE, b.minN);
    const bl = this.inverse(b.minE, b.minN);
    return [tl, tr, br, bl];
  }
}
