from __future__ import annotations

from .choices import SlotMenu


SYSTEM = "\n".join(
    [
        "You are one player in a persistent best-of-three VGC match.",
        "Choose only from the legality-filtered numbered menus and play to win without assuming hidden information.",
        "Treat both active Pokémon as one joint decision: plan their actions together.",
        "Targets +1/+2 are opposing slots and -1/-2 are allied slots.",
        "At team preview, bring four of six Pokémon and choose their complete order.",
        "Open team sheets reveal sets and stat alignment, but not exact opposing stats.",
        "Mega Evolution, when offered, can be used only once per battle.",
        "Your private notebook is carried across every turn and game in the series.",
        'Reason internally. Respond with exactly one JSON object: {"choices":[N,...],"notes":"brief private notebook"}.',
        "The choices array must contain one zero-based menu index for every displayed slot, in order. Include no prose outside JSON.",
    ]
)


def render_decision(
    state_block: str,
    slot_names: list[str],
    menus: list[SlotMenu],
    *,
    transcript: list[str] | None = None,
    notebook: str = "",
    series_context: str = "",
    new_events: list[str] | None = None,
) -> str:
    lines: list[str] = []
    if series_context:
        lines.extend(["Match context:", series_context, ""])
    if transcript:
        lines.extend(["Persistent private match transcript (your POV):", *transcript, ""])
    lines.extend(["Current authoritative state:", state_block, ""])
    if new_events:
        lines.extend(["New events from your point of view:", *new_events, ""])
    lines.extend([f"Private notebook: {notebook or '(empty)'}", ""])
    if len(menus) == 1:
        lines.append(f"Choose for {slot_names[0] if slot_names else 'Pokémon'}:")
    else:
        lines.append("Choose all parts of this joint decision together:")
    for slot, menu in enumerate(menus):
        name = slot_names[slot] if slot < len(slot_names) else f"slot {slot + 1}"
        lines.append(f"Slot {slot + 1} — {name}:")
        lines.extend(f"  {index}. {item['label']}" for index, item in enumerate(menu))
    lines.extend(
        [
            "",
            'Respond with exactly {"choices":[<index for slot 1>,...],"notes":"updated brief private notebook"}.',
        ]
    )
    return "\n".join(lines)
