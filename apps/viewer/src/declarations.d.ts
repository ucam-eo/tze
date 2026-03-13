declare module 'stac-js' {
  interface StacLink {
    href: string;
    rel: string;
    type?: string;
    title?: string;
  }

  interface StacEntity {
    id: string;
    bbox: number[];
    geometry: GeoJSON.Geometry;
    properties: Record<string, unknown>;
    assets: Record<string, { href: string; [key: string]: unknown }>;
    title?: string;
    getChildLinks(): StacLink[];
    getItemLinks(): StacLink[];
  }

  function create(data: Record<string, unknown>, migrate?: boolean): StacEntity;
  export default create;
}
