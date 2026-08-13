export interface DraftLeagueTopology {
  weekCount: number;
  roundRobinSeries: number;
  playoffRounds: 0 | 1 | 2;
  playoffSeries: 0 | 1 | 3;
  playoffEntrants: 0 | 2 | 4;
  totalSeries: number;
}

export function roundRobinWeeks(entrants: number): Array<Array<[number, number]>> {
  if (!Number.isSafeInteger(entrants) || entrants < 2) return [];
  const seats = [...Array(entrants).keys()];
  if (seats.length % 2) seats.push(-1);
  const weeks: Array<Array<[number, number]>> = [];
  for (let week = 0; week < seats.length - 1; week += 1) {
    const pairs: Array<[number, number]> = [];
    for (let match = 0; match < seats.length / 2; match += 1) {
      const home = seats[match]!;
      const away = seats[seats.length - 1 - match]!;
      if (home >= 0 && away >= 0) pairs.push(week % 2 ? [away, home] : [home, away]);
    }
    weeks.push(pairs);
    seats.splice(1, 0, seats.pop()!);
  }
  return weeks;
}

export function draftLeagueTopology(entrants: number): DraftLeagueTopology {
  if (!Number.isSafeInteger(entrants) || entrants < 2) {
    return {
      weekCount: 0,
      roundRobinSeries: 0,
      playoffRounds: 0,
      playoffSeries: 0,
      playoffEntrants: 0,
      totalSeries: 0,
    };
  }
  const weekCount = roundRobinWeeks(entrants).length;
  const roundRobinSeries = (entrants * (entrants - 1)) / 2;
  const expanded = entrants >= 5;
  const playoffRounds = expanded ? 2 : 1;
  const playoffSeries = expanded ? 3 : 1;
  const playoffEntrants = expanded ? 4 : 2;
  return {
    weekCount,
    roundRobinSeries,
    playoffRounds,
    playoffSeries,
    playoffEntrants,
    totalSeries: roundRobinSeries + playoffSeries,
  };
}
