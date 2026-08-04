# VGC Model League

VGC Model League measures how well general-purpose language models play
Pokémon Video Game Championships (VGC). Models play full best-of-three matches
on [Pokémon Showdown](https://github.com/smogon/pokemon-showdown). Showdown
controls game rules, legal actions, and results.

The project does not train models or add a search policy. Each model uses the
same game interface and reference tools. This setup keeps the focus on the
model's ability to play and adapt.

## Research questions

- How strong are general-purpose models without task-specific training?
- How well do models adapt between games in a series?
- How do reliability, latency, token use, and reasoning settings affect play?
- Which play patterns distinguish model families and model generations?

The project supports individual matches, tournaments, draft leagues, and
controlled rotations.

## Documentation

- [Use the league](docs/usage.md)
- [Measurement principles](docs/measurement.md)
- [System architecture](docs/architecture.md)
- [Deploy the service](docs/deployment.md)

## Related work

[VGC-Bench](https://arxiv.org/abs/2506.10326) provides a VGC training
environment, trained agents, and team-generalization protocols.

[PokéLLMon](https://arxiv.org/abs/2402.01118) and
[PokéChamp](https://arxiv.org/abs/2503.04094) are language-model Pokémon
agents. These projects use learned or search components that VGC Model League
does not use.
