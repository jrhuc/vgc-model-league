import { loadBoard } from '../../src/draft.js';
import { type TeamBuildArtifact, type TeamBuildTask, validateTeamBuildSubmission } from '../../src/teambuild.js';

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

export const LEGAL_TEAM_IDS = ['garchomp', 'incineroar', 'sinistcha', 'farigiraf', 'whimsicott', 'charizard-mega-y'];
const BOARD = loadBoard('regmb-202607');
const CANDIDATES = LEGAL_TEAM_IDS.map((id) => {
  const candidate = BOARD.mons.find((entry) => entry.id === id);
  if (!candidate) throw new Error(`board is missing ${id}`);
  return candidate;
});
const artifactCache = new Map<string, TeamBuildArtifact>();

export function leagueTeamBuildJournalRow(options: {
  teamPlan: string;
  notebook: string;
  attempts: number;
  sheetPolicy?: 'open' | 'closed';
}): { artifact: TeamBuildArtifact } {
  const cacheKey = JSON.stringify(options);
  let artifact = artifactCache.get(cacheKey);
  if (!artifact) {
    const task: TeamBuildTask = {
      id: 'series-0-seat-0',
      model: 'openai:alpha',
      format: BOARD.format,
      sheetPolicy: options.sheetPolicy ?? 'open',
      executionPolicy: 'strict',
      constraint: { kind: 'draft-picks', id: 'alpha-roster', teamSize: 6, candidates: CANDIDATES },
      objective: {
        kind: 'matchup',
        stage: 'roundrobin',
        opponent: { model: 'openai:beta', candidates: CANDIDATES },
        priorContext: [],
      },
      notebook: options.notebook,
      provenance: { source: 'draft-league', seriesIndex: 0, entrant: 0, opponent: 1 },
    };
    const result = validateTeamBuildSubmission(task, legalTeamResponse(options.teamPlan), {
      attempts: options.attempts,
      createdAt: '2026-07-20T09:00:00.000Z',
    });
    if (result.status !== 'accepted') {
      throw new Error(`league team-build fixture was rejected: ${result.problems.join('; ')}`);
    }
    artifact = result.artifact;
    artifactCache.set(cacheKey, artifact);
  }
  return { artifact: structuredClone(artifact) };
}
