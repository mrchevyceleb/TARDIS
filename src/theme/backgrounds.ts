// The stage and picker share these scenes. No downloads, canvas loops or timers:
// only a few compositor-animated CSS layers, paused when hidden or requested.
export const BACKGROUNDS = [
  { id: 'original', label: 'Console walls', blurb: 'The familiar roundels', animated: false },
  { id: 'plain', label: 'Clean slate', blurb: 'Just your palette', animated: false },
  { id: 'mesh', label: 'Silk sky', blurb: 'Soft pools of color', animated: false },
  { id: 'sunrise', label: 'Golden hour', blurb: 'A sun on the horizon', animated: false },
  { id: 'topography', label: 'Contour club', blurb: 'Quiet, rippling contours', animated: false },
  { id: 'grid', label: 'Dot journal', blurb: 'A little room to think', animated: false },
  { id: 'prism', label: 'Prism party', blurb: 'Folded ribbons of color', animated: false },
  { id: 'aurora', label: 'Aurora', blurb: 'Northern lights, unhurried', animated: true },
  { id: 'gradient', label: 'Color drift', blurb: 'A slowly shifting gradient', animated: true },
  { id: 'starfield', label: 'Stargazer', blurb: 'A drifting constellation', animated: true },
  { id: 'particles', label: 'Firefly garden', blurb: 'Little lights, gently rising', animated: true },
  { id: 'waves', label: 'Slow tide', blurb: 'Waves with nowhere to rush', animated: true },
] as const;
