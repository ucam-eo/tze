import type { TutorialDef } from '../tutorial';

export const understandingEmbeddings: TutorialDef = {
  id: 'understanding-embeddings',
  name: 'Understanding Embeddings',
  description: 'Fly to Cambridge, load embeddings, explore similarity and UMAP',
  steps: [
    {
      id: 'intro',
      title: 'Embeddings',
      description:
        'This tutorial will walk you through the embedding workflow.\n' +
        'You will learn how TZE uses per-pixel embeddings to find similar regions in satellite imagery.\n' +
        'Let\'s start by navigating to a zone with data.',
      trigger: { kind: 'click' },
    },
    {
      id: 'fly-to-cambridge',
      title: 'Navigate to Cambridge',
      description: 'Flying to Cambridge where we have pre-processed satellite data...',
      action: async (ctx) => {
        // Zoom 11 shows many tiles around the target area
        await ctx.flyTo({ center: [0.1218, 52.22], zoom: 11, duration: 2000 });
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'wait-zone',
      title: 'Loading Zone Data',
      description: 'Waiting for the zone metadata and tile grid to load...',
      action: async (ctx) => {
        await ctx.waitForEvent('metadata-loaded', 15000);
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'explain-tiles',
      title: 'Tile Grid',
      description:
        'The map is now showing a grid of tiles. Each tile is a chunk of the Zarr dataset.\n' +
        'Hover over tiles to see their outlines. Double-click loads the pixel embeddings for that tile.\n' +
        'Embeddings are dense feature vectors extracted by a neural network from each pixel.',
      highlight: '#map',
      arrow: 'none',
      trigger: { kind: 'click' },
    },
    {
      id: 'load-embeddings',
      title: 'Loading Embeddings',
      description:
        'Tessera embeddings are stored as Zarr arrays on a remote server.\n' +
        'We are fetching one tile\'s worth of per-pixel embeddings to the browser right now — this streams the compressed chunks over the network and decodes them locally.',
      action: async (ctx) => {
        if (!ctx.zarrSource) return;
        const chunk = ctx.zarrSource.getChunkAtLngLat(0.1218, 52.22);
        if (!chunk) return;
        const loaded = ctx.waitForEvent('embeddings-loaded', 30000);
        await ctx.zarrSource.loadFullChunk(chunk.ci, chunk.cj);
        await loaded;
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'explain-embeddings',
      title: 'What Are Embeddings?',
      description:
        'Each pixel now has an embedding — a high-dimensional vector that captures what the neural network "sees" at that location.\n' +
        'Similar land cover (e.g. two rooftops, two patches of grass) will have embeddings that are close together in this space.\n' +
        'Next, we\'ll switch to Similarity Search and select a reference pixel.',
      trigger: { kind: 'click' },
    },
    {
      id: 'run-similarity',
      title: 'Similarity Search',
      description: 'Switching to Similarity Search and clicking a reference pixel...',
      action: async (ctx) => {
        ctx.stores.activeTool.set('similarity');
        await new Promise((r) => setTimeout(r, 500));
        ctx.similarityClick(0.1218, 52.22);
        await new Promise((r) => setTimeout(r, 1500));
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'explain-umap',
      title: 'UMAP Visualization',
      description:
        'The UMAP window projects the high-dimensional embeddings down to 2D.\n' +
        'Each dot is a pixel. Similar pixels cluster together.\n' +
        'The highlighted point is your reference pixel, and the colors show cosine similarity.\n' +
        'Drag and resize the window to explore the embedding space.',
      highlight: '[data-tutorial="umap-cloud"]',
      arrow: 'left',
      spotlight: true,
      trigger: { kind: 'click' },
    },
    {
      id: 'threshold-demo',
      title: 'Threshold Slider',
      description: 'The threshold slider in the UMAP window controls which pixels are highlighted on the map.\nWatch the overlay change as the threshold sweeps...',
      highlight: '[data-tutorial="umap-threshold"]',
      arrow: 'left',
      action: async (ctx) => {
        // Animate threshold from 0.2 → 0.8 → 0.5
        const values = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.7, 0.6, 0.5];
        for (const v of values) {
          ctx.stores.simThreshold.set(v);
          await new Promise((r) => setTimeout(r, 400));
        }
      },
      trigger: { kind: 'action-complete' },
    },
    {
      id: 'summary',
      title: 'Tutorial Complete',
      description:
        'You\'ve learned the core embedding workflow:\n' +
        '1. Load tiles to fetch per-pixel embeddings from Zarr\n' +
        '2. Click a reference pixel for similarity search\n' +
        '3. Use the threshold slider to filter the overlay\n' +
        '4. Explore the UMAP projection of the embedding space\n\n' +
        'Try the Classify and Solar tools next to build on these concepts!',
      trigger: { kind: 'click' },
    },
  ],
};
