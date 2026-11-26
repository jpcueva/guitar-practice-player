// Section maps for songs whose tab has no section marks. Only bar numbers and
// names, keyed by song id, and used only when the tab has the same bar count.
// Worked out from the tab's riffs and where the vocals come in; edit them in
// the app (⚙ → Sections) if a boundary is off.
export const KNOWN_SECTIONS = {
  'when-all-light-dies': {
    bars: 278,
    sections: [
      { bar: 1, name: 'Intro' },
      { bar: 25, name: 'Main riff' },
      { bar: 41, name: 'Verse 1' },
      { bar: 57, name: 'Verse 1b' },
      { bar: 73, name: 'Pre-chorus' },
      { bar: 89, name: 'Chorus' },
      { bar: 105, name: 'Verse 2' },
      { bar: 121, name: 'Verse 2b' },
      { bar: 137, name: 'Pre-chorus' },
      { bar: 153, name: 'Chorus' },
      { bar: 169, name: 'Breakdown' },
      { bar: 177, name: 'Bridge' },
      { bar: 209, name: 'Solo' },
      { bar: 233, name: 'Build-up' },
      { bar: 241, name: 'Outro' },
    ],
  },
};
