const LEGAL_TEAM_SETS = [
  {
    id: 'garchomp',
    item: 'Life Orb',
    ability: 'Rough Skin',
    nature: 'Jolly',
    moves: ['Earthquake', 'Dragon Claw', 'Rock Slide', 'Protect'],
    evs: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 },
  },
  {
    id: 'incineroar',
    item: 'Sitrus Berry',
    ability: 'Intimidate',
    nature: 'Impish',
    moves: ['Fake Out', 'Flare Blitz', 'Parting Shot', 'Darkest Lariat'],
    evs: { hp: 32, atk: 0, def: 20, spa: 0, spd: 14, spe: 0 },
  },
  {
    id: 'sinistcha',
    item: 'Leftovers',
    ability: 'Hospitality',
    nature: 'Bold',
    moves: ['Matcha Gotcha', 'Rage Powder', 'Life Dew', 'Protect'],
    evs: { hp: 32, atk: 0, def: 20, spa: 0, spd: 14, spe: 0 },
  },
  {
    id: 'farigiraf',
    item: 'Colbur Berry',
    ability: 'Armor Tail',
    nature: 'Relaxed',
    moves: ['Psychic', 'Trick Room', 'Helping Hand', 'Protect'],
    evs: { hp: 32, atk: 0, def: 20, spa: 14, spd: 0, spe: 0 },
  },
  {
    id: 'whimsicott',
    item: 'Focus Sash',
    ability: 'Prankster',
    nature: 'Timid',
    moves: ['Tailwind', 'Encore', 'Moonblast', 'Protect'],
    evs: { hp: 2, atk: 0, def: 0, spa: 32, spd: 0, spe: 32 },
  },
  {
    id: 'charizard-mega-y',
    item: 'Charizardite Y',
    ability: 'Blaze',
    nature: 'Modest',
    moves: ['Heat Wave', 'Solar Beam', 'Weather Ball', 'Protect'],
    evs: { hp: 20, atk: 0, def: 0, spa: 32, spd: 0, spe: 14 },
  },
];

export function legalTeamResponse(teamPlan: string): string {
  return JSON.stringify({ team_plan: teamPlan, sets: LEGAL_TEAM_SETS });
}
